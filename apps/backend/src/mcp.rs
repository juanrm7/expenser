//! The MCP server at `/mcp`, through which AI assistants such as Claude read and manage the user's
//! expenses, categories and allowance.
//!
//! Clients authenticate with an API key (`Authorization: Bearer exp_…`); session cookies aren't
//! accepted, so a web page can't make a logged-in browser call it. There are no MCP sessions: each
//! request is served on its own, by a [`Server`] for the key's owner.

use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::WWW_AUTHENTICATE;
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use chrono::Days;
use libsql::params;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tower::ServiceExt;

use crate::auth::{self, User};
use crate::error::{AppError, Result};
use crate::expenses::{DatedExpense, Expense};
use crate::{AppState, categories, dates, db, expenses};

const INSTRUCTIONS: &str = "Expenser tracks the user's spending in Argentine pesos (ARS) against \
a weekly allowance. Weeks run Saturday through Friday; the monthly allowance is the weekly one \
prorated over the days of the month. Dates are calendar dates (YYYY-MM-DD) in the user's time \
zone, and get_summary tells you today's. Every expense belongs to one of the user's categories, \
named when adding it: check list_categories first, and only add a category when the user asks.";

/// How many expenses `list_expenses` returns by default, and at most.
const DEFAULT_LIST_LIMIT: usize = 100;
const MAX_LIST_LIMIT: usize = 500;

pub fn routes() -> Router<AppState> {
    Router::new().route("/mcp", any(serve))
}

async fn serve(State(state): State<AppState>, request: Request) -> Result<Response> {
    let Some(user) = auth::api_key_user(request.headers(), &state).await? else {
        return Ok(([(WWW_AUTHENTICATE, "Bearer")], AppError::unauthorized()).into_response());
    };
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        // Host checks protect servers that trust whoever can reach them (a local server, through
        // DNS rebinding). This one only trusts API keys, so it answers at any host it's served at.
        .disable_allowed_hosts();
    let service = StreamableHttpService::new(
        move || {
            Ok(Server {
                state: state.clone(),
                user: user.clone(),
            })
        },
        Arc::new(NeverSessionManager::default()),
        config,
    );
    let Ok(response) = service.oneshot(request).await;
    Ok(response.map(Body::new))
}

/// The MCP tools, acting as one user.
#[derive(Clone)]
struct Server {
    state: AppState,
    user: User,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SummaryArgs {
    /// The Saturday (YYYY-MM-DD) a past week starts on; the current week if omitted.
    week_start: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct ListExpensesArgs {
    /// Only expenses on or after this date (YYYY-MM-DD).
    from: Option<String>,
    /// Only expenses on or before this date (YYYY-MM-DD).
    to: Option<String>,
    /// Only expenses in this category, by name (ignoring case).
    category: Option<String>,
    /// Only expenses whose description contains this text (ignoring case).
    search: Option<String>,
    /// How many of the matching expenses to return, newest first: 100 if omitted, at most 500.
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpenseList {
    count: usize,
    total: f64,
    by_category: Vec<CategoryTotal>,
    expenses: Vec<DatedExpense>,
}

#[derive(Serialize)]
struct CategoryTotal {
    category: String,
    count: usize,
    total: f64,
}

#[derive(Deserialize, JsonSchema)]
struct AddExpenseArgs {
    /// The amount in ARS, greater than 0.
    amount: f64,
    /// What it was for, e.g. "Lunch with Ana".
    description: String,
    /// The name of one of the user's categories.
    category: String,
    /// The day it happened (YYYY-MM-DD), today or earlier; now if omitted.
    date: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct UpdateExpenseArgs {
    /// The expense's id.
    id: i64,
    /// The new amount in ARS, greater than 0.
    amount: Option<f64>,
    description: Option<String>,
    /// The name of one of the user's categories.
    category: Option<String>,
    /// The day it happened (YYYY-MM-DD), today or earlier.
    date: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct ExpenseId {
    /// The expense's id.
    id: i64,
}

#[derive(Deserialize, JsonSchema)]
struct AddCategoryArgs {
    name: String,
    /// The color the app shows it in, as #rrggbb, e.g. #10b981.
    color: String,
}

#[derive(Deserialize, JsonSchema)]
struct UpdateCategoryArgs {
    /// The category's id.
    id: i64,
    name: Option<String>,
    /// The color the app shows it in, as #rrggbb, e.g. #10b981.
    color: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct CategoryId {
    /// The category's id.
    id: i64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct UpdateProfileArgs {
    name: Option<String>,
    /// The weekly allowance in ARS, 0 or more.
    expendable_amount_per_week: Option<f64>,
}

#[tool_router]
impl Server {
    /// The balance of a week (allowance, spent, available and its expenses) and of the current
    /// month to date, plus today's date and the current week's start.
    #[tool(annotations(read_only_hint = true))]
    async fn get_summary(
        &self,
        Parameters(args): Parameters<SummaryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(expenses::summarize(&self.state, &self.user, args.week_start.as_deref()).await)
    }

    /// Searches the user's expenses. Returns the count and total of all matches, overall and per
    /// category, and the matching expenses themselves, newest first up to `limit`.
    #[tool(annotations(read_only_hint = true))]
    async fn list_expenses(
        &self,
        Parameters(args): Parameters<ListExpensesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(self.find_expenses(args).await)
    }

    /// Records an expense.
    #[tool(annotations(destructive_hint = false))]
    async fn add_expense(
        &self,
        Parameters(args): Parameters<AddExpenseArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let body = expenses::CreateBody {
                    amount: args.amount,
                    description: args.description,
                    category_id: self.category_id(&args.category).await?,
                    date: args.date,
                };
                let expense = expenses::add(&self.state, &self.user, body).await?;
                Ok(DatedExpense::from(expense))
            }
            .await,
        )
    }

    /// Changes an expense; omitted fields keep their value.
    #[tool]
    async fn update_expense(
        &self,
        Parameters(args): Parameters<UpdateExpenseArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(
            async {
                let category_id = match &args.category {
                    Some(name) => Some(self.category_id(name).await?),
                    None => None,
                };
                let body = expenses::UpdateBody {
                    amount: args.amount,
                    description: args.description,
                    category_id,
                    date: args.date,
                };
                let expense = expenses::edit(&self.state, &self.user, args.id, body).await?;
                Ok(DatedExpense::from(expense))
            }
            .await,
        )
    }

    /// Deletes an expense, returning it.
    #[tool]
    async fn delete_expense(
        &self,
        Parameters(ExpenseId { id }): Parameters<ExpenseId>,
    ) -> Result<CallToolResult, ErrorData> {
        let expense = expenses::delete(&self.state, &self.user, id).await;
        reply(expense.map(DatedExpense::from))
    }

    /// The user's expense categories.
    #[tool(annotations(read_only_hint = true))]
    async fn list_categories(&self) -> Result<CallToolResult, ErrorData> {
        reply(categories::all(&self.state.db, self.user.id).await)
    }

    /// Creates an expense category.
    #[tool(annotations(destructive_hint = false))]
    async fn add_category(
        &self,
        Parameters(args): Parameters<AddCategoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = categories::CreateBody {
            name: args.name,
            color: args.color,
        };
        reply(categories::add(&self.state.db, self.user.id, body).await)
    }

    /// Renames or recolors a category. Expenses already in it keep the name they were saved with.
    #[tool]
    async fn update_category(
        &self,
        Parameters(args): Parameters<UpdateCategoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = categories::UpdateBody {
            name: args.name,
            color: args.color,
        };
        reply(categories::edit(&self.state.db, self.user.id, args.id, body).await)
    }

    /// Deletes a category, returning it. Expenses in it keep its name.
    #[tool]
    async fn delete_category(
        &self,
        Parameters(CategoryId { id }): Parameters<CategoryId>,
    ) -> Result<CallToolResult, ErrorData> {
        reply(categories::delete(&self.state.db, self.user.id, id).await)
    }

    /// The user's name, email and weekly allowance (`expendableAmountPerWeek`, in ARS).
    #[tool(annotations(read_only_hint = true))]
    async fn get_profile(&self) -> Result<CallToolResult, ErrorData> {
        reply(Ok(&self.user))
    }

    /// Changes the user's name or weekly allowance; omitted fields keep their value.
    #[tool]
    async fn update_profile(
        &self,
        Parameters(args): Parameters<UpdateProfileArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let body = auth::UpdateProfileBody {
            name: args.name,
            expendable_amount_per_week: args.expendable_amount_per_week,
        };
        reply(auth::update_profile(&self.state, &self.user, body).await)
    }
}

#[tool_handler]
impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("expenser", env!("CARGO_PKG_VERSION")).with_title("Expenser"),
            )
            .with_instructions(INSTRUCTIONS)
    }
}

impl Server {
    async fn find_expenses(&self, args: ListExpensesArgs) -> Result<ExpenseList> {
        let date = |value: Option<String>, name: &str| {
            value
                .map(|value| {
                    dates::parse_date(&value).ok_or_else(|| {
                        AppError::bad_request(format!("{name} must be a date (YYYY-MM-DD)"))
                    })
                })
                .transpose()
        };
        let from = date(args.from, "from")?;
        let to = date(args.to, "to")?;
        if let (Some(from), Some(to)) = (from, to)
            && from > to
        {
            return Err(AppError::bad_request("from must be on or before to"));
        }

        let expenses: Vec<Expense> = db::fetch_all(
            &self.state.db,
            "SELECT * FROM Expense WHERE userId = ?1
                AND (?2 IS NULL OR createdAt >= ?2) AND (?3 IS NULL OR createdAt < ?3)
                AND (?4 IS NULL OR category = ?4 COLLATE NOCASE)
                AND (?5 IS NULL OR instr(lower(description), lower(?5)) > 0)
             ORDER BY createdAt DESC",
            params![
                self.user.id,
                from.map(|from| db::timestamp(dates::start_of_day(from))),
                to.map(|to| db::timestamp(dates::start_of_day(to + Days::new(1)))),
                args.category,
                args.search
            ],
        )
        .await?;

        let mut by_category: Vec<CategoryTotal> = Vec::new();
        for expense in &expenses {
            match by_category
                .iter_mut()
                .find(|total| total.category == expense.category)
            {
                Some(total) => {
                    total.count += 1;
                    total.total += expense.amount;
                }
                None => by_category.push(CategoryTotal {
                    category: expense.category.clone(),
                    count: 1,
                    total: expense.amount,
                }),
            }
        }
        by_category.sort_by(|a, b| b.total.total_cmp(&a.total));

        let limit = args.limit.unwrap_or(DEFAULT_LIST_LIMIT).min(MAX_LIST_LIMIT);
        Ok(ExpenseList {
            count: expenses.len(),
            total: expenses.iter().map(|expense| expense.amount).sum(),
            by_category,
            expenses: expenses
                .into_iter()
                .take(limit)
                .map(DatedExpense::from)
                .collect(),
        })
    }

    /// The id of the user's category with this name (ignoring case).
    async fn category_id(&self, name: &str) -> Result<i64> {
        let categories = categories::all(&self.state.db, self.user.id).await?;
        let wanted = name.trim().to_lowercase();
        if let Some(category) = categories
            .iter()
            .find(|category| category.name.trim().to_lowercase() == wanted)
        {
            return Ok(category.id);
        }
        let names: Vec<&str> = categories
            .iter()
            .map(|category| category.name.as_str())
            .collect();
        Err(AppError::not_found(format!(
            "There is no category named {name:?}. The user's categories are: {}",
            names.join(", ")
        )))
    }
}

/// A tool's result: the value as JSON, or an error the model can read and act on.
fn reply(result: Result<impl Serialize>) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(value) => Ok(CallToolResult::success(vec![ContentBlock::json(value)?])),
        Err(AppError::Client(_, message)) => {
            Ok(CallToolResult::error(vec![ContentBlock::text(message)]))
        }
        Err(AppError::Internal(err)) => {
            tracing::error!("{err:#}");
            Err(ErrorData::internal_error("Internal Server Error", None))
        }
    }
}
