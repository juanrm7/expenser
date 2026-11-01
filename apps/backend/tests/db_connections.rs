//! Request-local connections must not retain an expired Hrana stream across requests.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{HeaderValue, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::SameSite;
use chrono::Utc;
use expenser_backend::config::Config;
use expenser_backend::{AppState, RequestState, db};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tower::ServiceExt;

fn state(db: libsql::Database) -> AppState {
    AppState {
        db: Arc::new(db),
        config: Arc::new(Config {
            host: "127.0.0.1".into(),
            port: 0,
            api_url: "http://localhost".into(),
            webapp_url: HeaderValue::from_static("http://localhost:4321"),
            cookie_secure: false,
            cookie_same_site: SameSite::Lax,
            database_url: String::new(),
            database_auth_token: String::new(),
        }),
        clock: Utc::now,
    }
}

type ProbeResult = Result<String, (StatusCode, String)>;

fn failure(error: impl std::fmt::Display) -> (StatusCode, String) {
    (StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

async fn request(router: &Router, path: &str) -> (StatusCode, String) {
    let response = router
        .clone()
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

#[tokio::test]
async fn extractors_share_one_connection_only_within_the_request() {
    async fn share(first: RequestState, second: RequestState) -> ProbeResult {
        first
            .db
            .execute_batch(
                "CREATE TEMP TABLE request_marker (value INTEGER);
                 INSERT INTO request_marker VALUES (42)",
            )
            .await
            .map_err(failure)?;
        let value: i64 = db::fetch_value(&second.db, "SELECT value FROM request_marker", ())
            .await
            .map_err(failure)?;
        Ok(value.to_string())
    }

    async fn fresh(state: RequestState) -> ProbeResult {
        let tables: i64 = db::fetch_value(
            &state.db,
            "SELECT COUNT(*) FROM sqlite_temp_master WHERE name = 'request_marker'",
            (),
        )
        .await
        .map_err(failure)?;
        Ok(tables.to_string())
    }

    let dir = tempfile::tempdir().unwrap();
    let database = db::open(dir.path().join("test.db").to_str().unwrap(), "")
        .await
        .unwrap();
    let router = Router::new()
        .route("/share", get(share))
        .route("/fresh", get(fresh))
        .with_state(state(database));

    assert_eq!(
        request(&router, "/share").await,
        (StatusCode::OK, "42".into())
    );
    assert_eq!(
        request(&router, "/fresh").await,
        (StatusCode::OK, "0".into())
    );
    // A second request can create the same TEMP table, rather than reusing the first connection.
    assert_eq!(
        request(&router, "/share").await,
        (StatusCode::OK, "42".into())
    );
}

/// Only the Hrana operations used by `SELECT 1`: describe, cursor, and stream cleanup.
/// Each stream has a baton, and expired batons produce the same error as Turso.
/// Parse raw request bodies because libsql sends JSON without a Content-Type header.
#[derive(Default)]
struct Hrana {
    streams: Mutex<HashSet<String>>,
    next_stream: AtomicUsize,
    expire_next_cursor: AtomicBool,
}

impl Hrana {
    fn expired() -> Response {
        (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "stream not found: expired-test-stream" })),
        )
            .into_response()
    }

    async fn pipeline(State(server): State<Arc<Self>>, body: String) -> Response {
        let body: Value = serde_json::from_str(&body).unwrap();
        let mut streams = server.streams.lock().unwrap();
        let baton = if let Some(baton) = body["baton"].as_str() {
            if !streams.contains(baton) {
                return Self::expired();
            }
            baton.to_owned()
        } else {
            let id = server.next_stream.fetch_add(1, Ordering::SeqCst);
            let baton = format!("stream-{id}");
            streams.insert(baton.clone());
            baton
        };
        let mut closed = false;
        let results: Vec<Value> = body["requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|request| {
                let response = match request["type"].as_str().unwrap() {
                    "describe" => json!({
                        "type": "describe",
                        "result": {
                            "params": [],
                            "cols": [{ "name": "1", "decltype": null }],
                            "is_explain": false,
                            "is_readonly": true
                        }
                    }),
                    "close" => {
                        streams.remove(&baton);
                        closed = true;
                        json!({ "type": "close" })
                    }
                    other => panic!("unexpected Hrana operation: {other}"),
                };
                json!({ "type": "ok", "response": response })
            })
            .collect();
        Json(json!({
            "baton": if closed { None } else { Some(baton) },
            "base_url": null,
            "results": results
        }))
        .into_response()
    }

    async fn cursor(State(server): State<Arc<Self>>, body: String) -> Response {
        let body: Value = serde_json::from_str(&body).unwrap();
        let baton = body["baton"].as_str().unwrap();
        let mut streams = server.streams.lock().unwrap();
        if server.expire_next_cursor.swap(false, Ordering::SeqCst) {
            streams.remove(baton);
        }
        if !streams.contains(baton) {
            return Self::expired();
        }
        let lines = [
            json!({ "baton": baton, "base_url": null }),
            json!({ "type": "step_begin", "step": 0, "cols": [{ "name": "1", "decltype": null }] }),
            json!({ "type": "row", "row": [{ "type": "integer", "value": "1" }] }),
            json!({ "type": "step_end", "affected_row_count": 0, "last_inserted_rowid": null }),
        ];
        let body = lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>();
        ([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response()
    }
}

#[tokio::test]
async fn an_expired_remote_stream_does_not_poison_later_requests() {
    async fn probe(state: RequestState) -> ProbeResult {
        let value: i64 = db::fetch_value(&state.db, "SELECT 1", ())
            .await
            .map_err(failure)?;
        Ok(value.to_string())
    }

    let server = Arc::new(Hrana::default());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let hrana_router = Router::new()
        .route("/v3/pipeline", post(Hrana::pipeline))
        .route("/v3/cursor", post(Hrana::cursor))
        .with_state(server.clone());
    let task = tokio::spawn(async move { axum::serve(listener, hrana_router).await.unwrap() });
    let database = libsql::Builder::new_remote(url, String::new())
        .build()
        .await
        .unwrap();
    let router = Router::new()
        .route("/probe", get(probe))
        .with_state(state(database));

    // Expire the first stream between describe and query. The failed connection keeps its baton.
    server.expire_next_cursor.store(true, Ordering::SeqCst);
    let (status, body) = request(&router, "/probe").await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        body.contains("stream not found"),
        "unexpected error: {body}"
    );

    // A new request must open its own stream instead of reusing the failed one's baton.
    assert_eq!(
        request(&router, "/probe").await,
        (StatusCode::OK, "1".into())
    );

    // Simulate idle expiry / a database server restart between otherwise successful requests.
    server.streams.lock().unwrap().clear();
    assert_eq!(
        request(&router, "/probe").await,
        (StatusCode::OK, "1".into())
    );
    assert_eq!(server.next_stream.load(Ordering::SeqCst), 3);
    task.abort();
}
