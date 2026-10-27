//! Per-user API keys for scripts: `Authorization: Bearer exp_…`.
//!
//! Only a hash of each key is stored (see `tokens`); the key itself is returned once, on creation.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{delete, get};
use axum::{Json, Router};
use chrono::{DateTime, TimeDelta, Utc};
use libsql::params;
use serde::{Deserialize, Serialize};

use crate::auth::{SessionUser, User};
use crate::error::{AppError, Id, JsonBody, Result};
use crate::{AppState, db, tokens};

const KEY_PREFIX: &str = "exp_";
/// "exp_" plus 8 characters: enough to tell keys apart in the UI.
const DISPLAY_PREFIX_LENGTH: usize = 12;
const MAX_NAME_LENGTH: usize = 50;
const MAX_KEYS_PER_USER: i64 = 10;
/// `lastUsedAt` is written at most this often per key.
const LAST_USED_RESOLUTION: TimeDelta = TimeDelta::minutes(1);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiKey {
    id: i64,
    name: String,
    prefix: String,
    #[serde(serialize_with = "db::to_json_opt")]
    last_used_at: Option<DateTime<Utc>>,
    #[serde(serialize_with = "db::to_json")]
    created_at: DateTime<Utc>,
}

/// Returned once, on creation: the only time the full key is ever available.
#[derive(Serialize)]
struct CreatedApiKey {
    #[serde(flatten)]
    api_key: ApiKey,
    key: String,
}

/// Managing keys needs a real login (`SessionUser`), so a leaked key can't mint or revoke keys.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api-keys", get(list).post(create))
        .route("/api-keys/{id}", delete(revoke))
}

async fn list(
    State(state): State<AppState>,
    SessionUser(user): SessionUser,
) -> Result<Json<Vec<ApiKey>>> {
    let keys = db::fetch_all(
        &state.db,
        "SELECT id, name, prefix, lastUsedAt, createdAt FROM ApiKey
         WHERE userId = ?1 ORDER BY createdAt DESC, id DESC",
        [user.id],
    )
    .await?;
    Ok(Json(keys))
}

#[derive(Deserialize)]
struct CreateBody {
    name: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    SessionUser(user): SessionUser,
    JsonBody(body): JsonBody<CreateBody>,
) -> Result<(StatusCode, Json<CreatedApiKey>)> {
    let name = body.name.as_deref().unwrap_or_default().trim();
    if name.is_empty() {
        return Err(AppError::bad_request("Name is required"));
    }
    if name.chars().count() > MAX_NAME_LENGTH {
        return Err(AppError::bad_request(format!(
            "Name must be at most {MAX_NAME_LENGTH} characters"
        )));
    }

    let count: i64 = db::fetch_value(
        &state.db,
        "SELECT COUNT(*) FROM ApiKey WHERE userId = ?1",
        [user.id],
    )
    .await?;
    if count >= MAX_KEYS_PER_USER {
        return Err(AppError::bad_request(format!(
            "You can have at most {MAX_KEYS_PER_USER} API keys"
        )));
    }

    let key = tokens::generate(KEY_PREFIX)?;

    let api_key = db::fetch_one(
        &state.db,
        "INSERT INTO ApiKey (name, prefix, keyHash, createdAt, userId) VALUES (?1, ?2, ?3, ?4, ?5)
         RETURNING id, name, prefix, lastUsedAt, createdAt",
        params![
            name,
            &key[..DISPLAY_PREFIX_LENGTH],
            tokens::hash(&key),
            db::timestamp(state.now()),
            user.id
        ],
    )
    .await?;
    Ok((StatusCode::CREATED, Json(CreatedApiKey { api_key, key })))
}

async fn revoke(
    State(state): State<AppState>,
    SessionUser(user): SessionUser,
    Id(id): Id,
) -> Result<StatusCode> {
    let deleted = state
        .db
        .execute(
            "DELETE FROM ApiKey WHERE id = ?1 AND userId = ?2",
            [id, user.id],
        )
        .await?;
    if deleted == 0 {
        return Err(AppError::not_found("API key not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The owner of a raw API key, or `None` if the key is unknown or revoked.
pub async fn key_user(state: &AppState, key: &str) -> Result<Option<User>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct KeyOwner {
        key_id: i64,
        last_used_at: Option<DateTime<Utc>>,
        #[serde(flatten)]
        user: User,
    }

    if !key.starts_with(KEY_PREFIX) {
        return Ok(None);
    }
    let Some(owner) = db::fetch_optional::<KeyOwner>(
        &state.db,
        "SELECT ApiKey.id AS keyId, ApiKey.lastUsedAt AS lastUsedAt, User.id AS id, User.name AS name,
            User.email AS email, User.expendableAmountPerWeek AS expendableAmountPerWeek, User.role AS role
         FROM ApiKey JOIN User ON User.id = ApiKey.userId WHERE ApiKey.keyHash = ?1",
        [tokens::hash(key)],
    )
    .await?
    else {
        return Ok(None);
    };

    let now = state.now();
    if owner
        .last_used_at
        .is_none_or(|last_used| now - last_used > LAST_USED_RESOLUTION)
    {
        state
            .db
            .execute(
                "UPDATE ApiKey SET lastUsedAt = ?1 WHERE id = ?2",
                params![db::timestamp(now), owner.key_id],
            )
            .await?;
    }
    Ok(Some(owner.user))
}
