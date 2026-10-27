use std::env;

use anyhow::{Context, bail};
use axum::http::HeaderValue;
use axum_extra::extract::cookie::SameSite;
use url::Url;

/// Runtime configuration, read from the environment (and `apps/backend/.env`, see `.env.example`).
pub struct Config {
    pub host: String,
    pub port: u16,
    /// Where clients reach this API, without a trailing slash: the OAuth issuer, and the base of the
    /// MCP server's URL (`{api_url}/mcp`).
    pub api_url: String,
    /// The webapp's origin, the only one allowed by CORS.
    pub webapp_url: HeaderValue,
    pub cookie_secure: bool,
    pub cookie_same_site: SameSite,
    /// `libsql://…` for Turso, otherwise a local SQLite file (`file:` prefix optional).
    pub database_url: String,
    /// Only needed for remote (Turso) databases.
    pub database_auth_token: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let var = |name: &str, default: &str| env::var(name).unwrap_or_else(|_| default.to_owned());

        let port: u16 = var("PORT", "3001")
            .parse()
            .context("PORT must be a port number")?;
        let api_url = var("API_URL", &format!("http://localhost:{port}"));
        let api_url = api_url.trim_end_matches('/').to_owned();
        if !Url::parse(&api_url).is_ok_and(|url| matches!(url.scheme(), "http" | "https")) {
            bail!("API_URL must be an http(s) URL, not {api_url:?}");
        }

        Ok(Self {
            host: var("HOST", "0.0.0.0"),
            port,
            api_url,
            webapp_url: var("WEBAPP_URL", "http://localhost:4321")
                .parse()
                .context("WEBAPP_URL must be a valid origin")?,
            cookie_secure: var("SESSION_COOKIE_SECURE", "false") == "true",
            cookie_same_site: match var("SESSION_COOKIE_SAMESITE", "lax").as_str() {
                "lax" => SameSite::Lax,
                "strict" => SameSite::Strict,
                "none" => SameSite::None,
                other => {
                    bail!("SESSION_COOKIE_SAMESITE must be lax, strict or none, not {other:?}")
                }
            },
            database_url: var("TURSO_DATABASE_URL", "file:./dev.db"),
            database_auth_token: var("TURSO_AUTH_TOKEN", ""),
        })
    }
}
