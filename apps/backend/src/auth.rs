//! Accounts and sessions: `/auth/*` routes, and the extractors that authenticate other routes.
//!
//! Browsers authenticate with an httpOnly `session_id` cookie; scripts with an API key in an
//! `Authorization: Bearer exp_…` header (see `api_keys`).

use axum::extract::{FromRequestParts, State};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use axum_extra::extract::cookie::Cookie;
use chrono::{DateTime, TimeDelta, Utc};
use libsql::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, JsonBody, Result};
use crate::{AppState, api_keys, db};

const SESSION_COOKIE: &str = "session_id";
const SESSION_DAYS: i64 = 30;
const BCRYPT_COST: u32 = 10;
const MIN_PASSWORD_LENGTH: usize = 8;

/// The columns of a [`User`], for queries that join it.
const USER_COLUMNS: &str = "User.id AS id, User.name AS name, User.email AS email,
    User.expendableAmountPerWeek AS expendableAmountPerWeek, User.role AS role";

/// Every new account starts with these categories.
const STARTER_CATEGORIES_SQL: &str = "INSERT INTO Category (name, color, userId) VALUES
    ('Food', '#f97316', ?1), ('Transport', '#3b82f6', ?1), ('Entertainment', '#a855f7', ?1),
    ('Bills', '#ef4444', ?1), ('Other', '#6b7280', ?1)";

/// The authenticated user, as returned by `/auth/me`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: i64,
    pub name: String,
    pub email: String,
    pub expendable_amount_per_week: f64,
    pub role: Role,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    #[serde(other)]
    User,
}

/// Extracts the user authenticated by session cookie or API key; 401 if neither is valid.
pub struct AuthUser(pub User);

/// Like [`AuthUser`], but rejects API keys with a 403: for actions only a logged-in browser may take.
pub struct SessionUser(pub User);

enum AuthMethod {
    Session,
    ApiKey,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        match authenticate(&parts.headers, state).await? {
            Some((user, _)) => Ok(Self(user)),
            None => Err(AppError::unauthorized()),
        }
    }
}

impl FromRequestParts<AppState> for SessionUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self> {
        match authenticate(&parts.headers, state).await? {
            Some((user, AuthMethod::Session)) => Ok(Self(user)),
            Some((_, AuthMethod::ApiKey)) => Err(AppError::new(
                StatusCode::FORBIDDEN,
                "This action requires logging in, not an API key",
            )),
            None => Err(AppError::unauthorized()),
        }
    }
}

/// A valid session cookie takes precedence; otherwise an `Authorization: Bearer <api key>` header.
async fn authenticate(headers: &HeaderMap, state: &AppState) -> Result<Option<(User, AuthMethod)>> {
    if let Some(cookie) = CookieJar::from_headers(headers).get(SESSION_COOKIE)
        && let Some(user) = session_user(state, cookie.value()).await?
    {
        return Ok(Some((user, AuthMethod::Session)));
    }
    Ok(api_key_user(headers, state)
        .await?
        .map(|user| (user, AuthMethod::ApiKey)))
}

/// The owner of the `Authorization: Bearer <api key>` header's key, ignoring any session cookie.
pub async fn api_key_user(headers: &HeaderMap, state: &AppState) -> Result<Option<User>> {
    match bearer_token(headers) {
        Some(key) => api_keys::key_user(state, key).await,
        None => Ok(None),
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let (scheme, token) = headers.get(AUTHORIZATION)?.to_str().ok()?.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

async fn session_user(state: &AppState, session_id: &str) -> Result<Option<User>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SessionRow {
        expires_at: DateTime<Utc>,
        #[serde(flatten)]
        user: User,
    }

    let sql = format!(
        "SELECT Session.expiresAt AS expiresAt, {USER_COLUMNS}
         FROM Session JOIN User ON User.id = Session.userId WHERE Session.id = ?1"
    );
    let Some(session) = db::fetch_optional::<SessionRow>(&state.db, &sql, [session_id]).await?
    else {
        return Ok(None);
    };
    if session.expires_at <= state.now() {
        state
            .db
            .execute("DELETE FROM Session WHERE id = ?1", [session_id])
            .await?;
        return Ok(None);
    }
    Ok(Some(session.user))
}

/// Starts a session for the user, returning the cookie jar with its cookie set.
async fn start_session(state: &AppState, jar: CookieJar, user_id: i64) -> Result<CookieJar> {
    let id = Uuid::new_v4().to_string();
    let now = state.now();
    state
        .db
        .execute(
            "INSERT INTO Session (id, userId, expiresAt, createdAt) VALUES (?1, ?2, ?3, ?4)",
            params![
                id.as_str(),
                user_id,
                db::timestamp(now + TimeDelta::days(SESSION_DAYS)),
                db::timestamp(now)
            ],
        )
        .await?;
    Ok(jar.add(session_cookie(state, id)))
}

fn session_cookie(state: &AppState, value: String) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, value))
        .http_only(true)
        .same_site(state.config.cookie_same_site)
        .secure(state.config.cookie_secure)
        .path("/")
        .max_age(time::Duration::days(SESSION_DAYS))
        .build()
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/signup", post(signup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me).patch(update_me))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignupBody {
    name: Option<String>,
    email: Option<String>,
    password: Option<String>,
    expendable_amount_per_week: Option<f64>,
}

async fn signup(
    State(state): State<AppState>,
    jar: CookieJar,
    JsonBody(body): JsonBody<SignupBody>,
) -> Result<(StatusCode, CookieJar, Json<User>)> {
    let name = body.name.as_deref().unwrap_or_default().trim();
    let email = normalize_email(body.email.as_deref().unwrap_or_default());
    let password = body.password.unwrap_or_default();

    if name.is_empty() {
        return Err(AppError::bad_request("Name is required"));
    }
    if !is_valid_email(&email) {
        return Err(AppError::bad_request("Invalid email"));
    }
    if password.chars().count() < MIN_PASSWORD_LENGTH {
        return Err(AppError::bad_request(format!(
            "Password must be at least {MIN_PASSWORD_LENGTH} characters"
        )));
    }
    let Some(amount) = body
        .expendable_amount_per_week
        .filter(|&amount| is_valid_allowance(amount))
    else {
        return Err(AppError::bad_request("Invalid expendable amount"));
    };

    let taken: bool = db::fetch_value(
        &state.db,
        "SELECT EXISTS (SELECT 1 FROM User WHERE email = ?1)",
        [email.as_str()],
    )
    .await?;
    if taken {
        return Err(AppError::new(StatusCode::CONFLICT, "Email already in use"));
    }

    let password_hash =
        tokio::task::spawn_blocking(move || bcrypt::hash(password, BCRYPT_COST)).await??;
    let now = db::timestamp(state.now());

    let tx = state.db.transaction().await?;
    let user: User = db::fetch_one(
        &tx,
        "INSERT INTO User (name, email, passwordHash, expendableAmountPerWeek, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         RETURNING id, name, email, expendableAmountPerWeek, role",
        params![name, email, password_hash, amount, now],
    )
    .await?;
    tx.execute(STARTER_CATEGORIES_SQL, [user.id]).await?;
    tx.commit().await?;

    let jar = start_session(&state, jar, user.id).await?;
    Ok((StatusCode::CREATED, jar, Json(user)))
}

#[derive(Deserialize)]
struct LoginBody {
    email: Option<String>,
    password: Option<String>,
}

async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    JsonBody(body): JsonBody<LoginBody>,
) -> Result<(CookieJar, Json<User>)> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LoginRow {
        password_hash: String,
        #[serde(flatten)]
        user: User,
    }

    let email = normalize_email(body.email.as_deref().unwrap_or_default());
    let password = body.password.unwrap_or_default();
    if email.is_empty() || password.is_empty() {
        return Err(AppError::bad_request("Email and password are required"));
    }

    let invalid = || AppError::new(StatusCode::UNAUTHORIZED, "Invalid credentials");
    let sql = format!(
        "SELECT User.passwordHash AS passwordHash, {USER_COLUMNS} FROM User WHERE email = ?1"
    );
    let LoginRow {
        password_hash,
        user,
    } = db::fetch_optional(&state.db, &sql, [email])
        .await?
        .ok_or_else(invalid)?;
    let matches =
        tokio::task::spawn_blocking(move || bcrypt::verify(password, &password_hash)).await??;
    if !matches {
        return Err(invalid());
    }

    let jar = start_session(&state, jar, user.id).await?;
    Ok((jar, Json(user)))
}

async fn logout(
    State(state): State<AppState>,
    _: AuthUser,
    jar: CookieJar,
) -> Result<(StatusCode, CookieJar)> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        state
            .db
            .execute("DELETE FROM Session WHERE id = ?1", [cookie.value()])
            .await?;
    }
    Ok((
        StatusCode::NO_CONTENT,
        jar.remove(session_cookie(&state, String::new())),
    ))
}

async fn me(AuthUser(user): AuthUser) -> Json<User> {
    Json(user)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfileBody {
    pub name: Option<String>,
    pub expendable_amount_per_week: Option<f64>,
}

async fn update_me(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    JsonBody(body): JsonBody<UpdateProfileBody>,
) -> Result<Json<User>> {
    Ok(Json(update_profile(&state, &user, body).await?))
}

pub async fn update_profile(
    state: &AppState,
    user: &User,
    body: UpdateProfileBody,
) -> Result<User> {
    let name = body.name.map(|name| name.trim().to_owned());
    if name.as_deref() == Some("") {
        return Err(AppError::bad_request("Name cannot be empty"));
    }
    if body
        .expendable_amount_per_week
        .is_some_and(|amount| !is_valid_allowance(amount))
    {
        return Err(AppError::bad_request("Invalid expendable amount"));
    }

    let user = db::fetch_one(
        &state.db,
        "UPDATE User SET
            name = COALESCE(?1, name),
            expendableAmountPerWeek = COALESCE(?2, expendableAmountPerWeek),
            updatedAt = ?3
         WHERE id = ?4
         RETURNING id, name, email, expendableAmountPerWeek, role",
        params![
            name,
            body.expendable_amount_per_week,
            db::timestamp(state.now()),
            user.id
        ],
    )
    .await?;
    Ok(user)
}

fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Like `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`: one `@`, no whitespace, and a dot inside the domain.
fn is_valid_email(email: &str) -> bool {
    let is_part =
        |part: &str| !part.is_empty() && !part.contains(|c: char| c.is_whitespace() || c == '@');
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    is_part(local)
        && is_part(domain)
        && domain
            .char_indices()
            .any(|(i, c)| c == '.' && i > 0 && i + 1 < domain.len())
}

fn is_valid_allowance(amount: f64) -> bool {
    amount.is_finite() && amount >= 0.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_emails_like_the_previous_regex() {
        for valid in ["a@b.co", "first.last@mail.example.com", "a@b..", "a@.b.c"] {
            assert!(is_valid_email(valid), "{valid} should be valid");
        }
        for invalid in [
            "", "a", "a@b", "a@.b", "a@b.", "@b.co", "a@@b.co", "a b@c.co", "a@b@c.co",
        ] {
            assert!(!is_valid_email(invalid), "{invalid} should be invalid");
        }
    }
}
