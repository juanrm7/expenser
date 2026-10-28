//! OAuth 2.1 for the MCP server, which is how the Claude apps (web, desktop, mobile) connect to it:
//! discovery metadata (RFC 9728, RFC 8414), dynamic client registration (RFC 7591), the
//! authorization code flow with PKCE, and refresh token rotation.
//!
//! The flow: Claude registers itself, then sends the user to `GET /oauth/authorize`, which checks
//! the request and forwards it to the webapp's `/authorize` page. There the logged-in user approves
//! or denies it (`/oauth/consent`) and is sent back to Claude with a code, which Claude exchanges at
//! `/oauth/token` for an access token (`exa_…`, accepted by `/mcp` only) and a refresh token
//! (`exr_…`). Each approval is a grant: a connection the webapp's settings list and can revoke.

use axum::extract::rejection::{FormRejection, JsonRejection};
use axum::extract::{Query, RawQuery, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{delete, get, post};
use axum::{Form, Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, TimeDelta, Utc};
use libsql::params;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::{Host, Url};

use crate::auth::{self, SessionUser, USER_COLUMNS, User};
use crate::error::{AppError, Id, JsonBody, Result};
use crate::{AppState, db, tokens};

const ACCESS_TOKEN_PREFIX: &str = "exa_";
const REFRESH_TOKEN_PREFIX: &str = "exr_";
const CODE_LIFETIME: TimeDelta = TimeDelta::minutes(10);
const ACCESS_TOKEN_LIFETIME: TimeDelta = TimeDelta::hours(1);
/// Every refresh issues a new refresh token, so a connection that's in use never expires.
const REFRESH_TOKEN_LIFETIME: TimeDelta = TimeDelta::days(90);
/// `lastUsedAt` is written at most this often per grant.
const LAST_USED_RESOLUTION: TimeDelta = TimeDelta::minutes(1);
const MAX_REDIRECT_URIS: usize = 10;
const MAX_REDIRECT_URI_LENGTH: usize = 2000;
const MAX_CLIENT_NAME_LENGTH: usize = 100;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/.well-known/oauth-protected-resource",
            get(resource_metadata),
        )
        .route(
            "/.well-known/oauth-protected-resource/mcp",
            get(resource_metadata),
        )
        .route(
            "/.well-known/oauth-authorization-server",
            get(server_metadata),
        )
        .route("/oauth/register", post(register))
        .route("/oauth/authorize", get(authorize))
        .route("/oauth/consent", get(consent_request).post(consent))
        .route("/oauth/token", post(token))
        .route("/oauth/connections", get(connections))
        .route("/oauth/connections/{id}", delete(disconnect))
}

/// The MCP server's URL: the resource every token is for.
fn resource(state: &AppState) -> String {
    format!("{}/mcp", state.config.api_url)
}

/// Where `/mcp`'s metadata is, for the challenge it answers unauthenticated requests with.
pub fn resource_metadata_url(state: &AppState) -> String {
    format!(
        "{}/.well-known/oauth-protected-resource/mcp",
        state.config.api_url
    )
}

async fn resource_metadata(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "resource": resource(&state),
        "authorization_servers": [state.config.api_url],
        "bearer_methods_supported": ["header"],
        "resource_name": "Expenser",
    }))
}

async fn server_metadata(State(state): State<AppState>) -> Json<Value> {
    let issuer = &state.config.api_url;
    Json(json!({
        "issuer": issuer,
        "authorization_endpoint": format!("{issuer}/oauth/authorize"),
        "token_endpoint": format!("{issuer}/oauth/token"),
        "registration_endpoint": format!("{issuer}/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        // Clients are public: they prove themselves with PKCE, not a secret.
        "token_endpoint_auth_methods_supported": ["none"],
        // Tokens grant everything `/mcp` offers; this tells clients a refresh token comes with them.
        "scopes_supported": ["offline_access"],
    }))
}

/// A token or registration endpoint error, as OAuth clients expect it (RFC 6749 §5.2):
/// `{ "error": "invalid_grant", "error_description": "…" }`.
#[derive(Debug)]
enum OAuthError {
    Client(&'static str, String),
    Internal(anyhow::Error),
}

impl OAuthError {
    fn new(error: &'static str, description: impl Into<String>) -> Self {
        Self::Client(error, description.into())
    }
}

impl<E: Into<anyhow::Error>> From<E> for OAuthError {
    fn from(err: E) -> Self {
        Self::Internal(err.into())
    }
}

impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        match self {
            Self::Client(error, description) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": error, "error_description": description })),
            )
                .into_response(),
            Self::Internal(err) => {
                tracing::error!("{err:#}");
                let body = Json(json!({ "error": "server_error" }));
                (StatusCode::INTERNAL_SERVER_ERROR, body).into_response()
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Client {
    id: String,
    name: String,
    /// A JSON array.
    redirect_uris: String,
}

impl Client {
    /// The redirect URI, if it's one of this client's. Loopback URIs match on any port (RFC 8252
    /// §7.3), since native apps like Claude Code listen on a new one each time.
    fn redirect_uri(&self, uri: &str) -> anyhow::Result<Option<Url>> {
        let Ok(requested) = Url::parse(uri) else {
            return Ok(None);
        };
        let registered: Vec<String> = serde_json::from_str(&self.redirect_uris)?;
        let matches = registered
            .iter()
            .filter_map(|uri| Url::parse(uri).ok())
            .any(|registered| {
                if is_loopback(&registered) && is_loopback(&requested) {
                    let mut on_registered_port = requested.clone();
                    on_registered_port.set_port(registered.port()).is_ok()
                        && on_registered_port == registered
                } else {
                    requested == registered
                }
            });
        Ok(matches.then_some(requested))
    }
}

/// A redirect URI a client may register: HTTPS, or for native apps HTTP on a loopback address
/// (RFC 8252 §7.3). Never with a fragment.
fn parse_redirect_uri(uri: &str) -> Option<Url> {
    let url = Url::parse(uri)
        .ok()
        .filter(|_| uri.len() <= MAX_REDIRECT_URI_LENGTH)?;
    let allowed = url.fragment().is_none() && (url.scheme() == "https" || is_loopback(&url));
    allowed.then_some(url)
}

fn is_loopback(url: &Url) -> bool {
    url.scheme() == "http"
        && match url.host() {
            Some(Host::Domain(domain)) => domain == "localhost",
            Some(Host::Ipv4(ip)) => ip.is_loopback(),
            Some(Host::Ipv6(ip)) => ip.is_loopback(),
            None => false,
        }
}

#[derive(Deserialize)]
struct RegisterBody {
    redirect_uris: Option<Vec<String>>,
    client_name: Option<String>,
}

#[derive(Serialize)]
struct RegisteredClient {
    client_id: String,
    client_id_issued_at: i64,
    client_name: String,
    redirect_uris: Vec<String>,
    grant_types: [&'static str; 2],
    response_types: [&'static str; 1],
    token_endpoint_auth_method: &'static str,
}

/// Dynamic client registration (RFC 7591). Every client is registered as a public one, whatever
/// authentication method it asks for.
async fn register(
    State(state): State<AppState>,
    body: std::result::Result<Json<RegisterBody>, JsonRejection>,
) -> Result<(StatusCode, Json<RegisteredClient>), OAuthError> {
    let Json(body) = body
        .map_err(|rejection| OAuthError::new("invalid_client_metadata", rejection.body_text()))?;
    let uris = body.redirect_uris.unwrap_or_default();
    if uris.is_empty() || uris.len() > MAX_REDIRECT_URIS {
        return Err(OAuthError::new(
            "invalid_redirect_uri",
            format!("Register 1 to {MAX_REDIRECT_URIS} redirect_uris"),
        ));
    }
    let Some(redirect_uris) = uris
        .iter()
        .map(|uri| parse_redirect_uri(uri).map(String::from))
        .collect::<Option<Vec<_>>>()
    else {
        return Err(OAuthError::new(
            "invalid_redirect_uri",
            "Redirect URIs must be https, or http on a loopback address, without a fragment",
        ));
    };
    let name = match body.client_name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => name.chars().take(MAX_CLIENT_NAME_LENGTH).collect(),
        // Named after where it sends people back to, e.g. "claude.ai".
        _ => Url::parse(&redirect_uris[0])?
            .host_str()
            .unwrap_or("An app")
            .to_owned(),
    };

    let id = tokens::generate("")?;
    let now = state.now();
    state
        .db
        .execute(
            "INSERT INTO OAuthClient (id, name, redirectUris, createdAt) VALUES (?1, ?2, ?3, ?4)",
            params![
                id.as_str(),
                name.as_str(),
                serde_json::to_string(&redirect_uris)?,
                db::timestamp(now)
            ],
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(RegisteredClient {
            client_id: id,
            client_id_issued_at: now.timestamp(),
            client_name: name,
            redirect_uris,
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
        }),
    ))
}

#[derive(Deserialize)]
struct AuthorizeParams {
    response_type: Option<String>,
    client_id: Option<String>,
    redirect_uri: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    state: Option<String>,
    resource: Option<String>,
}

/// An authorization request from a known client, to one of its redirect URIs.
struct Authorization {
    client: Client,
    redirect_uri: Url,
    params: AuthorizeParams,
}

impl Authorization {
    /// Checks the request's client and redirect URI. Until both are known to be valid nothing may
    /// be sent to that URI, so these errors are for the user.
    async fn new(state: &AppState, params: AuthorizeParams) -> Result<Self> {
        let invalid =
            || AppError::bad_request("This sign-in link is invalid: unknown app or redirect");
        let client_id = params.client_id.as_deref().ok_or_else(invalid)?;
        let client: Client = db::fetch_optional(
            &state.db,
            "SELECT id, name, redirectUris FROM OAuthClient WHERE id = ?1",
            [client_id],
        )
        .await?
        .ok_or_else(invalid)?;
        let redirect_uri = match params.redirect_uri.as_deref() {
            Some(uri) => client.redirect_uri(uri)?,
            None => None,
        }
        .ok_or_else(invalid)?;
        Ok(Self {
            client,
            redirect_uri,
            params,
        })
    }

    /// What's wrong with the rest of the request, as an OAuth error code and description.
    fn error(&self, state: &AppState) -> Option<(&'static str, String)> {
        let params = &self.params;
        if params.response_type.as_deref() != Some("code") {
            return Some((
                "unsupported_response_type",
                "response_type must be code".into(),
            ));
        }
        if !params.code_challenge.as_deref().is_some_and(is_pkce_value)
            || params.code_challenge_method.as_deref() != Some("S256")
        {
            return Some((
                "invalid_request",
                "A PKCE code_challenge, with code_challenge_method S256, is required".into(),
            ));
        }
        if let Some(target) = &params.resource
            && *target != resource(state)
        {
            return Some((
                "invalid_target",
                format!("resource must be {}", resource(state)),
            ));
        }
        None
    }

    /// The redirect URI with these query parameters added, and the request's `state`.
    fn redirect(&self, params: &[(&str, &str)]) -> String {
        let mut url = self.redirect_uri.clone();
        {
            let mut query = url.query_pairs_mut();
            query.extend_pairs(params);
            if let Some(state) = &self.params.state {
                query.append_pair("state", state);
            }
        }
        url.into()
    }
}

/// A PKCE code verifier or challenge: 43 to 128 unreserved characters (RFC 7636 §4.1).
fn is_pkce_value(value: &str) -> bool {
    (43..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~".contains(&byte))
}

/// The S256 challenge of a PKCE code verifier.
fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier))
}

/// The authorization endpoint: errors in a request from a valid client go back to it; valid
/// requests go on to the webapp, where the user approves or denies them.
async fn authorize(
    State(state): State<AppState>,
    RawQuery(query): RawQuery,
    Query(params): Query<AuthorizeParams>,
) -> Result<Redirect> {
    let request = Authorization::new(&state, params).await?;
    if let Some((error, description)) = request.error(&state) {
        let redirect = request.redirect(&[("error", error), ("error_description", &description)]);
        return Ok(Redirect::to(&redirect));
    }
    let webapp = state.config.webapp_url.to_str()?;
    Ok(Redirect::to(&format!(
        "{webapp}/authorize?{}",
        query.unwrap_or_default()
    )))
}

/// An authorization request the user can decide on. The webapp passes on the query it was sent,
/// which `authorize` already checked, so any error here is explained to the user.
async fn decidable(state: &AppState, params: AuthorizeParams) -> Result<Authorization> {
    let request = Authorization::new(state, params).await?;
    match request.error(state) {
        Some((_, description)) => Err(AppError::bad_request(description)),
        None => Ok(request),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsentRequest {
    client_name: String,
    redirect_uri: String,
}

/// What the consent page shows: who's asking, and where they'll be sent back to.
async fn consent_request(
    State(state): State<AppState>,
    SessionUser(_): SessionUser,
    Query(params): Query<AuthorizeParams>,
) -> Result<Json<ConsentRequest>> {
    let request = decidable(&state, params).await?;
    Ok(Json(ConsentRequest {
        client_name: request.client.name,
        redirect_uri: request.redirect_uri.into(),
    }))
}

#[derive(Deserialize)]
struct ConsentBody {
    approve: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsentResult {
    /// Where the webapp sends the user: the client's redirect URI, with a code or an error.
    redirect_to: String,
}

/// The user's decision. A logged-in browser only (`SessionUser`), so an API key can't grant access.
async fn consent(
    State(state): State<AppState>,
    SessionUser(user): SessionUser,
    Query(params): Query<AuthorizeParams>,
    JsonBody(body): JsonBody<ConsentBody>,
) -> Result<Json<ConsentResult>> {
    let request = decidable(&state, params).await?;
    if !body.approve {
        let redirect_to = request.redirect(&[("error", "access_denied")]);
        return Ok(Json(ConsentResult { redirect_to }));
    }

    let code = tokens::generate("")?;
    let now = state.now();
    state
        .db
        .execute(
            "DELETE FROM OAuthCode WHERE expiresAt <= ?1",
            [db::timestamp(now)],
        )
        .await?;
    state
        .db
        .execute(
            "INSERT INTO OAuthCode (codeHash, clientId, userId, redirectUri, codeChallenge, expiresAt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                tokens::hash(&code),
                request.client.id.as_str(),
                user.id,
                request.redirect_uri.as_str(),
                // `decidable` checked it's there.
                request.params.code_challenge.as_deref().unwrap_or_default(),
                db::timestamp(now + CODE_LIFETIME)
            ],
        )
        .await?;
    let redirect_to = request.redirect(&[("code", &code)]);
    Ok(Json(ConsentResult { redirect_to }))
}

#[derive(Deserialize)]
struct TokenParams {
    grant_type: Option<String>,
    client_id: Option<String>,
    code: Option<String>,
    redirect_uri: Option<String>,
    code_verifier: Option<String>,
    refresh_token: Option<String>,
    resource: Option<String>,
}

#[derive(Serialize)]
struct Tokens {
    access_token: String,
    token_type: &'static str,
    expires_in: i64,
    refresh_token: String,
}

impl Tokens {
    fn generate() -> anyhow::Result<Self> {
        Ok(Self {
            access_token: tokens::generate(ACCESS_TOKEN_PREFIX)?,
            token_type: "Bearer",
            expires_in: ACCESS_TOKEN_LIFETIME.num_seconds(),
            refresh_token: tokens::generate(REFRESH_TOKEN_PREFIX)?,
        })
    }
}

/// The token endpoint: exchanges a code, or a refresh token, for new tokens.
async fn token(
    State(state): State<AppState>,
    form: std::result::Result<Form<TokenParams>, FormRejection>,
) -> Result<Response, OAuthError> {
    let Form(params) =
        form.map_err(|rejection| OAuthError::new("invalid_request", rejection.body_text()))?;
    let Some(client_id) = params.client_id.as_deref() else {
        return Err(OAuthError::new("invalid_request", "client_id is required"));
    };
    if let Some(target) = &params.resource
        && *target != resource(&state)
    {
        let description = format!("resource must be {}", resource(&state));
        return Err(OAuthError::new("invalid_target", description));
    }
    let tokens = match params.grant_type.as_deref() {
        Some("authorization_code") => exchange_code(&state, client_id, &params).await?,
        Some("refresh_token") => refresh(&state, client_id, &params).await?,
        _ => {
            return Err(OAuthError::new(
                "unsupported_grant_type",
                "grant_type must be authorization_code or refresh_token",
            ));
        }
    };
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(tokens)).into_response())
}

/// Starts a grant: the user's connection to the client.
async fn exchange_code(
    state: &AppState,
    client_id: &str,
    params: &TokenParams,
) -> Result<Tokens, OAuthError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Code {
        client_id: String,
        user_id: i64,
        redirect_uri: String,
        code_challenge: String,
        expires_at: DateTime<Utc>,
    }

    let invalid = || OAuthError::new("invalid_grant", "The code is invalid, expired or used");
    let code = params.code.as_deref().ok_or_else(invalid)?;
    // Deleted as it's read, so it works once, even when two requests race.
    let code: Code = db::fetch_optional(
        &state.db,
        "DELETE FROM OAuthCode WHERE codeHash = ?1
         RETURNING clientId, userId, redirectUri, codeChallenge, expiresAt",
        [tokens::hash(code)],
    )
    .await?
    .ok_or_else(invalid)?;
    let redirect_uri = params.redirect_uri.as_deref().map(Url::parse);
    let now = state.now();
    if code.expires_at <= now
        || code.client_id != client_id
        || !matches!(redirect_uri, Some(Ok(uri)) if uri.as_str() == code.redirect_uri)
    {
        return Err(invalid());
    }
    if !params.code_verifier.as_deref().is_some_and(|verifier| {
        is_pkce_value(verifier) && pkce_challenge(verifier) == code.code_challenge
    }) {
        return Err(OAuthError::new(
            "invalid_grant",
            "code_verifier doesn't match the code_challenge",
        ));
    }

    let tokens = Tokens::generate()?;
    state
        .db
        .execute(
            "DELETE FROM OAuthGrant WHERE refreshExpiresAt <= ?1",
            [db::timestamp(now)],
        )
        .await?;
    state
        .db
        .execute(
            "INSERT INTO OAuthGrant (clientId, userId, accessTokenHash, accessExpiresAt,
                refreshTokenHash, refreshExpiresAt, createdAt)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                code.client_id,
                code.user_id,
                tokens::hash(&tokens.access_token),
                db::timestamp(now + ACCESS_TOKEN_LIFETIME),
                tokens::hash(&tokens.refresh_token),
                db::timestamp(now + REFRESH_TOKEN_LIFETIME),
                db::timestamp(now)
            ],
        )
        .await?;
    Ok(tokens)
}

/// Replaces a grant's tokens. The old refresh token stops working, as does the old access token.
async fn refresh(
    state: &AppState,
    client_id: &str,
    params: &TokenParams,
) -> Result<Tokens, OAuthError> {
    let Some(refresh_token) = params.refresh_token.as_deref() else {
        return Err(OAuthError::new(
            "invalid_request",
            "refresh_token is required",
        ));
    };
    let tokens = Tokens::generate()?;
    let now = state.now();
    // One UPDATE, so a refresh token works once, even when two requests race.
    let rotated = state
        .db
        .execute(
            "UPDATE OAuthGrant SET accessTokenHash = ?1, accessExpiresAt = ?2,
                refreshTokenHash = ?3, refreshExpiresAt = ?4
             WHERE refreshTokenHash = ?5 AND clientId = ?6 AND refreshExpiresAt > ?7",
            params![
                tokens::hash(&tokens.access_token),
                db::timestamp(now + ACCESS_TOKEN_LIFETIME),
                tokens::hash(&tokens.refresh_token),
                db::timestamp(now + REFRESH_TOKEN_LIFETIME),
                tokens::hash(refresh_token),
                client_id,
                db::timestamp(now)
            ],
        )
        .await?;
    if rotated == 0 {
        return Err(OAuthError::new(
            "invalid_grant",
            "The refresh token is invalid, expired or revoked",
        ));
    }
    Ok(tokens)
}

/// The user an `Authorization: Bearer exa_…` access token was issued to, while it's current.
pub async fn access_token_user(headers: &HeaderMap, state: &AppState) -> Result<Option<User>> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct GrantOwner {
        grant_id: i64,
        last_used_at: Option<DateTime<Utc>>,
        #[serde(flatten)]
        user: User,
    }

    let Some(token) =
        auth::bearer_token(headers).filter(|token| token.starts_with(ACCESS_TOKEN_PREFIX))
    else {
        return Ok(None);
    };
    let now = state.now();
    let sql = format!(
        "SELECT OAuthGrant.id AS grantId, OAuthGrant.lastUsedAt AS lastUsedAt, {USER_COLUMNS}
         FROM OAuthGrant JOIN User ON User.id = OAuthGrant.userId
         WHERE OAuthGrant.accessTokenHash = ?1 AND OAuthGrant.accessExpiresAt > ?2"
    );
    let Some(owner) = db::fetch_optional::<GrantOwner>(
        &state.db,
        &sql,
        params![tokens::hash(token), db::timestamp(now)],
    )
    .await?
    else {
        return Ok(None);
    };

    if owner
        .last_used_at
        .is_none_or(|last_used| now - last_used > LAST_USED_RESOLUTION)
    {
        state
            .db
            .execute(
                "UPDATE OAuthGrant SET lastUsedAt = ?1 WHERE id = ?2",
                params![db::timestamp(now), owner.grant_id],
            )
            .await?;
    }
    Ok(Some(owner.user))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    id: i64,
    client_name: String,
    #[serde(serialize_with = "db::to_json_opt")]
    last_used_at: Option<DateTime<Utc>>,
    #[serde(serialize_with = "db::to_json")]
    created_at: DateTime<Utc>,
}

/// The apps the user has connected, newest first.
async fn connections(
    State(state): State<AppState>,
    SessionUser(user): SessionUser,
) -> Result<Json<Vec<Connection>>> {
    let connections = db::fetch_all(
        &state.db,
        "SELECT OAuthGrant.id AS id, OAuthClient.name AS clientName,
            OAuthGrant.lastUsedAt AS lastUsedAt, OAuthGrant.createdAt AS createdAt
         FROM OAuthGrant JOIN OAuthClient ON OAuthClient.id = OAuthGrant.clientId
         WHERE OAuthGrant.userId = ?1 AND OAuthGrant.refreshExpiresAt > ?2
         ORDER BY OAuthGrant.createdAt DESC, OAuthGrant.id DESC",
        params![user.id, db::timestamp(state.now())],
    )
    .await?;
    Ok(Json(connections))
}

/// Revokes a connection: its access and refresh tokens stop working at once.
async fn disconnect(
    State(state): State<AppState>,
    SessionUser(user): SessionUser,
    Id(id): Id,
) -> Result<StatusCode> {
    let deleted = state
        .db
        .execute(
            "DELETE FROM OAuthGrant WHERE id = ?1 AND userId = ?2",
            [id, user.id],
        )
        .await?;
    if deleted == 0 {
        return Err(AppError::not_found("Connection not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}
