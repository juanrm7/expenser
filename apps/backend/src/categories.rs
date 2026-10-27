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

/// The user's categories, oldest first.
pub async fn all(conn: &Connection, user_id: i64) -> Result<Vec<Category>> {
    let categories = db::fetch_all(
        conn,
        "SELECT * FROM Category WHERE userId = ?1 ORDER BY id",
        [user_id],
    )
    .await?;
    Ok(categories)
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
    Ok(Json(all(&state.db, user.id).await?))
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
pub struct CreateBody {
    pub name: String,
    pub color: String,
}

async fn create(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    JsonBody(body): JsonBody<CreateBody>,
) -> Result<(StatusCode, Json<Category>)> {
    let category = add(&state.db, user.id, body).await?;
    Ok((StatusCode::CREATED, Json(category)))
}

pub async fn add(conn: &Connection, user_id: i64, body: CreateBody) -> Result<Category> {
    let category = db::fetch_one(
        conn,
        "INSERT INTO Category (name, color, userId) VALUES (?1, ?2, ?3) RETURNING *",
        params![body.name, body.color, user_id],
    )
    .await?;
    Ok(category)
}

#[derive(Deserialize)]
pub struct UpdateBody {
    pub name: Option<String>,
    pub color: Option<String>,
}

async fn update(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Id(id): Id,
    JsonBody(body): JsonBody<UpdateBody>,
) -> Result<Json<Category>> {
    Ok(Json(edit(&state.db, user.id, id, body).await?))
}

pub async fn edit(conn: &Connection, user_id: i64, id: i64, body: UpdateBody) -> Result<Category> {
    let category = db::fetch_optional(
        conn,
        "UPDATE Category SET name = COALESCE(?1, name), color = COALESCE(?2, color)
         WHERE id = ?3 AND userId = ?4 RETURNING *",
        params![body.name, body.color, id, user_id],
    )
    .await?
    .ok_or_else(not_found)?;
    Ok(category)
}

async fn remove(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Id(id): Id,
) -> Result<StatusCode> {
    delete(&state.db, user.id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Deletes a category, returning it. Expenses keep its name, so deleting it doesn't touch them.
pub async fn delete(conn: &Connection, user_id: i64, id: i64) -> Result<Category> {
    let category = db::fetch_optional(
        conn,
        "DELETE FROM Category WHERE id = ?1 AND userId = ?2 RETURNING *",
        [id, user_id],
    )
    .await?
    .ok_or_else(not_found)?;
    Ok(category)
}
