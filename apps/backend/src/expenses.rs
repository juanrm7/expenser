//! Per-user expenses, and the weekly/monthly summary the home screen is built from.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Datelike, Days, Months, NaiveDate, Utc, Weekday};
use libsql::params;
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::{AppError, Id, JsonBody, Result};
use crate::{AppState, categories, dates, db};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expense {
    pub id: i64,
    pub description: String,
    pub amount: f64,
    /// The category's name at the time it was set: not a reference, so it survives the category.
    pub category: String,
    /// When the expense happened: now by default, or the start of the day it was dated.
    #[serde(serialize_with = "db::to_json")]
    pub created_at: DateTime<Utc>,
    #[serde(serialize_with = "db::to_json")]
    pub updated_at: DateTime<Utc>,
    pub user_id: i64,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/expenses", get(list).post(create))
        .route("/expenses/summary", get(summary))
        .route("/expenses/{id}", get(show).patch(update).delete(remove))
}

fn not_found() -> AppError {
    AppError::not_found("Expense not found")
}

async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<Expense>>> {
    let expenses = db::fetch_all(
        &state.db,
        "SELECT * FROM Expense WHERE userId = ?1 ORDER BY createdAt DESC",
        [user.id],
    )
    .await?;
    Ok(Json(expenses))
}

async fn show(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Id(id): Id,
) -> Result<Json<Expense>> {
    let expense = db::fetch_optional(
        &state.db,
        "SELECT * FROM Expense WHERE id = ?1 AND userId = ?2",
        [id, user.id],
    )
    .await?
    .ok_or_else(not_found)?;
    Ok(Json(expense))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SummaryQuery {
    /// A previous week to show, by its Saturday (`YYYY-MM-DD`); the current week by default.
    week_start: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    week_start: NaiveDate,
    current_week_start: NaiveDate,
    today: NaiveDate,
    allowance: f64,
    spent: f64,
    available: f64,
    expenses: Vec<WeekExpense>,
    monthly: MonthlySummary,
}

#[derive(Serialize)]
struct WeekExpense {
    #[serde(flatten)]
    expense: Expense,
    /// The local calendar date, so clients in other time zones show and edit the same day.
    date: NaiveDate,
}

/// The current calendar month to date.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonthlySummary {
    month_start: NaiveDate,
    allowance: f64,
    spent: f64,
    available: f64,
}

async fn summary(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(query): Query<SummaryQuery>,
) -> Result<Json<Summary>> {
    let today = dates::local_date(state.now());
    let current_week_start = dates::week_start(today);
    let week_start = match query.week_start {
        None => current_week_start,
        Some(value) => match dates::parse_date(&value) {
            Some(date) if date.weekday() == Weekday::Sat && date <= current_week_start => date,
            _ => {
                return Err(AppError::bad_request(
                    "weekStart must be a Saturday on or before the current week (YYYY-MM-DD)",
                ));
            }
        },
    };
    let month_start = dates::month_start(today);
    let next_month_start = month_start + Months::new(1);

    let expenses: Vec<Expense> = db::fetch_all(
        &state.db,
        "SELECT * FROM Expense WHERE userId = ?1 AND createdAt >= ?2 AND createdAt < ?3
         ORDER BY createdAt DESC",
        params![
            user.id,
            db::timestamp(dates::start_of_day(week_start)),
            db::timestamp(dates::start_of_day(week_start + Days::new(7)))
        ],
    )
    .await?;
    let monthly_spent: f64 = db::fetch_value(
        &state.db,
        "SELECT TOTAL(amount) FROM Expense WHERE userId = ?1 AND createdAt >= ?2 AND createdAt < ?3",
        params![
            user.id,
            db::timestamp(dates::start_of_day(month_start)),
            db::timestamp(dates::start_of_day(next_month_start))
        ],
    )
    .await?;

    let allowance = user.expendable_amount_per_week;
    let spent = expenses
        .iter()
        .fold(0.0, |sum, expense| sum + expense.amount);
    let days_in_month = (next_month_start - month_start).num_days() as f64;
    let monthly_allowance = allowance / 7.0 * days_in_month;

    Ok(Json(Summary {
        week_start,
        current_week_start,
        today,
        allowance,
        spent,
        available: allowance - spent,
        expenses: expenses
            .into_iter()
            .map(|expense| WeekExpense {
                date: dates::local_date(expense.created_at),
                expense,
            })
            .collect(),
        monthly: MonthlySummary {
            month_start,
            allowance: monthly_allowance,
            spent: monthly_spent,
            available: monthly_allowance - monthly_spent,
        },
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    amount: f64,
    description: String,
    category_id: i64,
    /// `YYYY-MM-DD`, on or before today; the expense is recorded as happening now if omitted.
    date: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    JsonBody(body): JsonBody<CreateBody>,
) -> Result<(StatusCode, Json<Expense>)> {
    let now = state.now();
    check_amount(body.amount)?;
    let created_at = match &body.date {
        Some(date) => expense_date(date, dates::local_date(now))?,
        None => now,
    };
    let category = categories::find(&state.db, user.id, body.category_id)
        .await?
        .ok_or_else(|| AppError::not_found("Category not found"))?;

    let expense = db::fetch_one(
        &state.db,
        "INSERT INTO Expense (description, amount, category, createdAt, updatedAt, userId)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING *",
        params![
            body.description,
            body.amount,
            category.name,
            db::timestamp(created_at),
            db::timestamp(now),
            user.id
        ],
    )
    .await?;
    Ok((StatusCode::CREATED, Json(expense)))
}

/// Omitted fields keep their value: an expense whose category was deleted keeps its name, and one
/// without a new `date` keeps its original one.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    amount: Option<f64>,
    description: Option<String>,
    category_id: Option<i64>,
    date: Option<String>,
}

async fn update(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Id(id): Id,
    JsonBody(body): JsonBody<UpdateBody>,
) -> Result<Json<Expense>> {
    if body.amount.is_none()
        && body.description.is_none()
        && body.category_id.is_none()
        && body.date.is_none()
    {
        return Err(AppError::bad_request("Nothing to update"));
    }
    let now = state.now();
    if let Some(amount) = body.amount {
        check_amount(amount)?;
    }
    let created_at = match &body.date {
        Some(date) => Some(db::timestamp(expense_date(date, dates::local_date(now))?)),
        None => None,
    };
    let category = match body.category_id {
        Some(category_id) => Some(
            categories::find(&state.db, user.id, category_id)
                .await?
                .ok_or_else(|| AppError::not_found("Category not found"))?
                .name,
        ),
        None => None,
    };

    let expense = db::fetch_optional(
        &state.db,
        "UPDATE Expense SET
            amount = COALESCE(?1, amount),
            description = COALESCE(?2, description),
            category = COALESCE(?3, category),
            createdAt = COALESCE(?4, createdAt),
            updatedAt = ?5
         WHERE id = ?6 AND userId = ?7
         RETURNING *",
        params![
            body.amount,
            body.description,
            category,
            created_at,
            db::timestamp(now),
            id,
            user.id
        ],
    )
    .await?
    .ok_or_else(not_found)?;
    Ok(Json(expense))
}

async fn remove(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Id(id): Id,
) -> Result<StatusCode> {
    let deleted = state
        .db
        .execute(
            "DELETE FROM Expense WHERE id = ?1 AND userId = ?2",
            [id, user.id],
        )
        .await?;
    if deleted == 0 {
        return Err(not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

fn check_amount(amount: f64) -> Result<()> {
    if amount > 0.0 {
        Ok(())
    } else {
        Err(AppError::bad_request("Amount must be greater than 0"))
    }
}

/// The instant an expense dated `YYYY-MM-DD` is recorded at: the start of that (past) day.
fn expense_date(date: &str, today: NaiveDate) -> Result<DateTime<Utc>> {
    match dates::parse_date(date) {
        Some(date) if date <= today => Ok(dates::start_of_day(date)),
        _ => Err(AppError::bad_request(
            "Enter a valid expense date on or before today (YYYY-MM-DD)",
        )),
    }
}
