//! Per-user expense categories.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use libsql::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::auth::AuthUser;
use crate::error::{AppError, Id, JsonBody, Result};
use crate::{AppState, db};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub user_id: i64,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/categories", get(list).post(create))
        .route("/categories/{id}", get(show).patch(update).delete(remove))
}

/// The user's category with this id, if there is one.
pub async fn find(conn: &Connection, user_id: i64, id: i64) -> Result<Option<Category>> {
    let category = db::fetch_optional(
        conn,
        "SELECT * FROM Category WHERE id = ?1 AND userId = ?2",
        [id, user_id],
    )
    .await?;
    Ok(category)
}

fn not_found() -> AppError {
    AppError::not_found("Category not found")
}

async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> Result<Json<Vec<Category>>> {
    let categories = db::fetch_all(
        &state.db,
        "SELECT * FROM Category WHERE userId = ?1 ORDER BY id",
        [user.id],
    )
    .await?;
    Ok(Json(categories))
}

async fn show(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Id(id): Id,
) -> Result<Json<Category>> {
    let category = find(&state.db, user.id, id).await?.ok_or_else(not_found)?;
    Ok(Json(category))
}

#[derive(Deserialize)]
struct CreateBody {
    name: String,
    color: String,
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    JsonBody(body): JsonBody<CreateBody>,
) -> Result<(StatusCode, Json<Category>)> {
    let category = db::fetch_one(
        &state.db,
        "INSERT INTO Category (name, color, userId) VALUES (?1, ?2, ?3) RETURNING *",
        params![body.name, body.color, user.id],
    )
    .await?;
    Ok((StatusCode::CREATED, Json(category)))
}

#[derive(Deserialize)]
struct UpdateBody {
    name: Option<String>,
    color: Option<String>,
}

async fn update(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Id(id): Id,
    JsonBody(body): JsonBody<UpdateBody>,
) -> Result<Json<Category>> {
    let category = db::fetch_optional(
        &state.db,
        "UPDATE Category SET name = COALESCE(?1, name), color = COALESCE(?2, color)
         WHERE id = ?3 AND userId = ?4 RETURNING *",
        params![body.name, body.color, id, user.id],
    )
    .await?
    .ok_or_else(not_found)?;
    Ok(Json(category))
}

/// Expenses keep their category's name, so deleting a category doesn't touch them.
async fn remove(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Id(id): Id,
) -> Result<StatusCode> {
    let deleted = state
        .db
        .execute(
            "DELETE FROM Category WHERE id = ?1 AND userId = ?2",
            [id, user.id],
        )
        .await?;
    if deleted == 0 {
        return Err(not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}
