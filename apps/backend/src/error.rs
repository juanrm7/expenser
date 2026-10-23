use axum::Json;
use axum::extract::{FromRequest, FromRequestParts, Path, Request};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde::de::DeserializeOwned;
use serde_json::json;

pub type Result<T, E = AppError> = std::result::Result<T, E>;

/// A handler error. Every error response has the body `{ "message": "…" }`.
#[derive(Debug)]
pub enum AppError {
    /// An expected failure, explained to the client.
    Client(StatusCode, String),
    /// Anything unexpected: logged, and answered with a generic 500.
    Internal(anyhow::Error),
}

impl AppError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self::Client(status, message.into())
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "Unauthorized")
    }
}

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(err: E) -> Self {
        Self::Internal(err.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::Client(status, message) => (status, message),
            Self::Internal(err) => {
                tracing::error!("{err:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error".to_owned(),
                )
            }
        };
        (status, Json(json!({ "message": message }))).into_response()
    }
}

/// A JSON request body. Unlike `axum::Json`, a malformed body gets the usual `{ "message" }` 400.
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(AppError::bad_request(rejection.body_text())),
        }
    }
}

/// The numeric `{id}` of a route like `/expenses/{id}`.
pub struct Id(pub i64);

impl<S: Send + Sync> FromRequestParts<S> for Id {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self> {
        match Path::<i64>::from_request_parts(parts, state).await {
            Ok(Path(id)) => Ok(Self(id)),
            Err(_) => Err(AppError::bad_request("Invalid id")),
        }
    }
}
