//! Expenser's REST API: per-user weekly/monthly expense tracking in ARS.

mod api_keys;
mod auth;
mod categories;
pub mod config;
mod dates;
pub mod db;
mod error;
mod expenses;
mod mcp;
mod oauth;
mod tokens;

use std::sync::Arc;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderName, Method, Request};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use tower::ServiceBuilder;
use tower_http::cors::{AllowHeaders, CorsLayer};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::{DefaultOnResponse, TraceLayer};
use tracing::Level;

use crate::config::Config;
use crate::error::AppError;

/// Ties a request's log lines to the webapp's console logs: taken from the request (or generated)
/// and echoed on the response.
const CORRELATION_ID: HeaderName = HeaderName::from_static("x-correlation-id");

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<libsql::Database>,
    pub config: Arc<Config>,
    /// The current time. Swappable so tests can fix "today".
    pub clock: fn() -> DateTime<Utc>,
}

/// One connection per HTTP request, shared by its authentication, handler and MCP tools.
/// A remote connection holds a Hrana session that can expire; only the database handle belongs
/// in process-wide state. Cloning a connection would keep sharing the same session.
#[derive(Clone)]
pub struct RequestState {
    pub db: libsql::Connection,
    pub config: Arc<Config>,
    /// The current time. Swappable so tests can fix "today".
    pub clock: fn() -> DateTime<Utc>,
}

impl RequestState {
    pub fn now(&self) -> DateTime<Utc> {
        (self.clock)()
    }
}

impl FromRequestParts<AppState> for RequestState {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        if let Some(state) = parts.extensions.get::<Self>() {
            return Ok(state.clone());
        }
        let request_state = Self {
            db: state.db.connect()?,
            config: state.config.clone(),
            clock: state.clock,
        };
        parts.extensions.insert(request_state.clone());
        Ok(request_state)
    }
}

pub fn app(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(state.config.webapp_url.clone())
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(AllowHeaders::mirror_request())
        .expose_headers([CORRELATION_ID]);

    let trace = TraceLayer::new_for_http()
        .make_span_with(|req: &Request<_>| {
            let id = req
                .headers()
                .get(&CORRELATION_ID)
                .and_then(|id| id.to_str().ok());
            tracing::info_span!("request", method = %req.method(), uri = %req.uri(), id)
        })
        .on_response(DefaultOnResponse::new().level(Level::INFO))
        // 500s are logged, with their cause, by `AppError`.
        .on_failure(());

    Router::new()
        .route("/health", get(health))
        .merge(auth::routes())
        .merge(categories::routes())
        .merge(expenses::routes())
        .merge(api_keys::routes())
        .merge(mcp::routes())
        .merge(oauth::routes())
        .fallback(|| async { AppError::not_found("Route not found") })
        .layer(
            ServiceBuilder::new()
                .layer(SetRequestIdLayer::new(CORRELATION_ID, MakeRequestUuid))
                .layer(trace)
                .layer(PropagateRequestIdLayer::new(CORRELATION_ID))
                .layer(cors),
        )
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "message": "Hello World" }))
}
