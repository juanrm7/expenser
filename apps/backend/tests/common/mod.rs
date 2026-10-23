//! Drives the real router against a temporary database, with "now" fixed at [`now`].

#![allow(dead_code)] // Each test file uses a different subset.

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{HeaderMap, HeaderValue, Request, StatusCode};
use axum_extra::extract::cookie::SameSite;
use chrono::{DateTime, Local, NaiveDateTime, TimeDelta, TimeZone, Utc};
use expenser_backend::config::Config;
use expenser_backend::{AppState, app, db};
use libsql::params;
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;

/// The session cookie of seeded user 1, which requests use unless they pass their own headers.
pub const USER_1: (&str, &str) = ("cookie", "session_id=session-1");

pub struct TestApp {
    router: Router,
    pub db: libsql::Connection,
    _dir: TempDir,
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Value,
}

impl TestResponse {
    pub fn header(&self, name: &str) -> &str {
        self.headers
            .get(name)
            .map_or("", |value| value.to_str().unwrap())
    }
}

/// A local date and time, like JavaScript's `new Date('2026-10-22T12:00:00')`.
pub fn local(value: &str) -> DateTime<Utc> {
    let naive = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").unwrap();
    Local.from_local_datetime(&naive).unwrap().to_utc()
}

/// "Now" in every test: Thursday 2026-10-22 at noon, local time.
pub fn now() -> DateTime<Utc> {
    local("2026-10-22T12:00:00")
}

/// An instant as the API formats it.
pub fn iso(instant: DateTime<Utc>) -> String {
    instant.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub async fn spawn() -> TestApp {
    // Shown for failing tests only, e.g. the cause of a 500.
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let dir = tempfile::tempdir().unwrap();
    let db = db::open(dir.path().join("test.db").to_str().unwrap(), "")
        .await
        .unwrap();
    let config = Config {
        host: "127.0.0.1".into(),
        port: 0,
        webapp_url: HeaderValue::from_static("http://localhost:4321"),
        cookie_secure: false,
        cookie_same_site: SameSite::Lax,
        database_url: String::new(),
        database_auth_token: String::new(),
    };
    let state = AppState {
        db: db.clone(),
        config: Arc::new(config),
        clock: now,
    };
    TestApp {
        router: app(state),
        db,
        _dir: dir,
    }
}

impl TestApp {
    /// Users 1 and 2, with sessions `session-1` and `session-2`; categories 1–2 belong to user 1
    /// and category 3 to user 2.
    pub async fn seed_users(&self) {
        for id in [1, 2] {
            self.db
                .execute(
                    "INSERT INTO User (id, name, email, passwordHash, expendableAmountPerWeek, createdAt, updatedAt)
                     VALUES (?1, ?2, ?3, 'test', 1000, ?4, ?4)",
                    params![id, format!("User {id}"), format!("user{id}@example.com"), db::timestamp(now())],
                )
                .await
                .unwrap();
            self.db
                .execute(
                    "INSERT INTO Session (id, userId, expiresAt) VALUES (?1, ?2, ?3)",
                    params![
                        format!("session-{id}"),
                        id,
                        db::timestamp(now() + TimeDelta::days(1))
                    ],
                )
                .await
                .unwrap();
        }
        self.db
            .execute_batch(
                "INSERT INTO Category (id, name, color, userId) VALUES
                    (1, 'Food', '#10b981', 1), (2, 'Transport', '#3b82f6', 1), (3, 'Other user', '#3b82f6', 2)",
            )
            .await
            .unwrap();
    }

    /// Inserts an expense at a local date and time, returning its id.
    pub async fn seed_expense(&self, at: &str, amount: f64, user_id: i64) -> i64 {
        let created_at = db::timestamp(local(at));
        let mut rows = self
            .db
            .query(
                "INSERT INTO Expense (description, amount, category, createdAt, updatedAt, userId)
                 VALUES ('Existing expense', ?1, 'Food', ?2, ?2, ?3) RETURNING id",
                params![amount, created_at, user_id],
            )
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get(0).unwrap()
    }

    pub async fn get(&self, uri: &str) -> TestResponse {
        self.request("GET", uri, None, &[USER_1]).await
    }

    pub async fn post(&self, uri: &str, body: Value) -> TestResponse {
        self.request("POST", uri, Some(body), &[USER_1]).await
    }

    pub async fn patch(&self, uri: &str, body: Value) -> TestResponse {
        self.request("PATCH", uri, Some(body), &[USER_1]).await
    }

    pub async fn delete(&self, uri: &str) -> TestResponse {
        self.request("DELETE", uri, None, &[USER_1]).await
    }

    pub async fn request(
        &self,
        method: &str,
        uri: &str,
        body: Option<Value>,
        headers: &[(&str, &str)],
    ) -> TestResponse {
        let mut request = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        };

        let response = self.router.clone().oneshot(request.unwrap()).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        TestResponse {
            status,
            headers,
            body,
        }
    }
}
