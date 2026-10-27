use std::env;
use std::sync::Arc;

use anyhow::Context;
use chrono::Utc;
use expenser_backend::config::Config;
use expenser_backend::{AppState, app, db};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Variables already set (e.g. by pm2) take precedence over the file, which is optional.
    if let Err(err) = dotenvy::dotenv()
        && !err.not_found()
    {
        return Err(err).context("failed to load .env");
    }
    // rmcp logs every MCP request's lifecycle at info. RUST_LOG's directives come last, so they win:
    // `RUST_LOG=rmcp=info` shows it again.
    let directives = format!(
        "info,rmcp=warn,{}",
        env::var("RUST_LOG").unwrap_or_default()
    );
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_new(directives).unwrap_or_else(|_| EnvFilter::new("info,rmcp=warn")),
        )
        .init();

    let config = Config::from_env()?;
    let db = db::open(&config.database_url, &config.database_auth_token).await?;
    let listener = TcpListener::bind((config.host.as_str(), config.port))
        .await
        .with_context(|| format!("failed to listen on {}:{}", config.host, config.port))?;
    tracing::info!("listening on http://{}", listener.local_addr()?);

    let state = AppState {
        db,
        config: Arc::new(config),
        clock: Utc::now,
    };
    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Resolves on Ctrl+C / SIGINT (what pm2 sends) or SIGTERM, letting in-flight requests finish.
async fn shutdown_signal() {
    let interrupt = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to listen for Ctrl+C");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to listen for SIGTERM")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => {},
        () = terminate => {},
    }
    tracing::info!("shutting down");
}
