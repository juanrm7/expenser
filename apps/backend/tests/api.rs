//! Accounts, sessions, categories, API keys, and HTTP plumbing.

mod common;

use chrono::TimeDelta;
use common::{TestApp, USER_1, iso, now, spawn};
use expenser_backend::db;
use libsql::params;
use serde_json::{Value, json};

async fn signup(app: &TestApp, email: &str) -> (Value, String) {
    let body = json!({ "name": " Ana ", "email": email, "password": "password1", "expendableAmountPerWeek": 1000 });
    let response = app.request("POST", "/auth/signup", Some(body), &[]).await;
    assert_eq!(response.status, 201, "{}", response.body);
    let cookie = response
        .header("set-cookie")
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    (response.body, cookie)
}

#[tokio::test]
async fn signup_creates_an_account_with_starter_categories_and_a_session() {
    let app = spawn().await;
    let (user, cookie) = signup(&app, "  Ana@Example.com ").await;
    assert_eq!(
        user,
        json!({ "id": 1, "name": "Ana", "email": "ana@example.com", "expendableAmountPerWeek": 1000.0, "role": "user" })
    );

    let categories = app
        .request("GET", "/categories", None, &[("cookie", &cookie)])
        .await
        .body;
    let names: Vec<&str> = categories
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["Food", "Transport", "Entertainment", "Bills", "Other"]
    );
    assert_eq!(
        categories[0],
        json!({ "id": 1, "name": "Food", "color": "#f97316", "userId": 1 })
    );

    let duplicate = json!({ "name": "Ana", "email": "ANA@example.com", "password": "password1", "expendableAmountPerWeek": 1 });
    let response = app
        .request("POST", "/auth/signup", Some(duplicate), &[])
        .await;
    assert_eq!(response.status, 409);
    assert_eq!(response.body["message"], "Email already in use");
}

#[tokio::test]
async fn signup_validates_its_fields() {
    let app = spawn().await;
    let valid = json!({ "name": "Ana", "email": "ana@example.com", "password": "password1", "expendableAmountPerWeek": 0 });
    for (change, message) in [
        (json!({ "name": "  " }), "Name is required"),
        (json!({ "email": "ana@example" }), "Invalid email"),
        (
            json!({ "password": "short" }),
            "Password must be at least 8 characters",
        ),
        (
            json!({ "expendableAmountPerWeek": -1 }),
            "Invalid expendable amount",
        ),
        (
            json!({ "expendableAmountPerWeek": null }),
            "Invalid expendable amount",
        ),
    ] {
        let mut body = valid.clone();
        body.as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        let response = app.request("POST", "/auth/signup", Some(body), &[]).await;
        assert_eq!(response.status, 400, "{change}");
        assert_eq!(response.body["message"], message);
    }
}

#[tokio::test]
async fn sessions_log_in_update_the_profile_and_log_out() {
    let app = spawn().await;
    let (_, signup_cookie) = signup(&app, "ana@example.com").await;

    let wrong = json!({ "email": "ana@example.com", "password": "wrong-password" });
    let response = app.request("POST", "/auth/login", Some(wrong), &[]).await;
    assert_eq!(response.status, 401);
    assert_eq!(response.body["message"], "Invalid credentials");
    let missing = app
        .request(
            "POST",
            "/auth/login",
            Some(json!({ "email": "ana@example.com" })),
            &[],
        )
        .await;
    assert_eq!(missing.status, 400);

    let login = json!({ "email": " ANA@example.com", "password": "password1" });
    let response = app.request("POST", "/auth/login", Some(login), &[]).await;
    assert_eq!(response.status, 200);
    assert_eq!(response.body["email"], "ana@example.com");
    let set_cookie = response.header("set-cookie");
    for attribute in ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=2592000"] {
        assert!(
            set_cookie.contains(attribute),
            "{set_cookie} lacks {attribute}"
        );
    }
    assert!(!set_cookie.contains("Secure"));
    let cookie = set_cookie.split(';').next().unwrap().to_owned();
    assert_ne!(cookie, signup_cookie);

    let auth = [("cookie", cookie.as_str())];
    let changes = json!({ "name": " Ana María ", "expendableAmountPerWeek": 1500.5 });
    let updated = app.request("PATCH", "/auth/me", Some(changes), &auth).await;
    assert_eq!(updated.status, 200);
    assert_eq!(updated.body["name"], "Ana María");
    assert_eq!(updated.body["expendableAmountPerWeek"], 1500.5);
    let only_name = app
        .request("PATCH", "/auth/me", Some(json!({ "name": "Ana" })), &auth)
        .await;
    assert_eq!(only_name.body["expendableAmountPerWeek"], 1500.5);
    assert_eq!(
        app.request("PATCH", "/auth/me", Some(json!({ "name": " " })), &auth)
            .await
            .status,
        400
    );
    let negative = json!({ "expendableAmountPerWeek": -5 });
    assert_eq!(
        app.request("PATCH", "/auth/me", Some(negative), &auth)
            .await
            .status,
        400
    );
    assert_eq!(
        app.request("GET", "/auth/me", None, &auth).await.body["name"],
        "Ana"
    );

    let logout = app.request("POST", "/auth/logout", None, &auth).await;
    assert_eq!(logout.status, 204);
    assert!(logout.header("set-cookie").starts_with("session_id=;"));
    assert!(logout.header("set-cookie").contains("Max-Age=0"));
    assert_eq!(
        app.request("GET", "/auth/me", None, &auth).await.status,
        401
    );
    // Logging out ends only that session.
    assert_eq!(
        app.request("GET", "/auth/me", None, &[("cookie", &signup_cookie)])
            .await
            .status,
        200
    );
}

#[tokio::test]
async fn expired_sessions_are_rejected_and_removed() {
    let app = spawn().await;
    app.seed_users().await;
    app.db
        .execute(
            "UPDATE Session SET expiresAt = ?1 WHERE id = 'session-1'",
            [db::timestamp(now() - TimeDelta::seconds(1))],
        )
        .await
        .unwrap();

    assert_eq!(app.get("/auth/me").await.status, 401);
    let mut rows = app
        .db
        .query("SELECT COUNT(*) FROM Session", ())
        .await
        .unwrap();
    let remaining: i64 = rows.next().await.unwrap().unwrap().get(0).unwrap();
    assert_eq!(remaining, 1);
}

#[tokio::test]
async fn categories_are_managed_per_user() {
    let app = spawn().await;
    app.seed_users().await;

    let created = app
        .post("/categories", json!({ "name": "Pets", "color": "#123456" }))
        .await;
    assert_eq!(created.status, 201);
    assert_eq!(
        created.body,
        json!({ "id": 4, "name": "Pets", "color": "#123456", "userId": 1 })
    );
    assert_eq!(
        app.post("/categories", json!({ "name": "No color" }))
            .await
            .status,
        400
    );

    let renamed = app
        .patch("/categories/4", json!({ "name": "Pet care" }))
        .await;
    assert_eq!(
        renamed.body,
        json!({ "id": 4, "name": "Pet care", "color": "#123456", "userId": 1 })
    );
    assert_eq!(app.get("/categories/4").await.body["name"], "Pet care");
    let ids: Vec<i64> = app
        .get("/categories")
        .await
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [1, 2, 4]);

    assert_eq!(app.get("/categories/3").await.status, 404);
    assert_eq!(
        app.patch("/categories/3", json!({ "name": "Mine" }))
            .await
            .status,
        404
    );
    assert_eq!(app.delete("/categories/3").await.status, 404);

    assert_eq!(app.delete("/categories/4").await.status, 204);
    let gone = app.get("/categories/4").await;
    assert_eq!(gone.status, 404);
    assert_eq!(gone.body["message"], "Category not found");
}

#[tokio::test]
async fn api_keys_authenticate_scripts_but_cannot_manage_keys() {
    let app = spawn().await;
    app.seed_users().await;

    let created = app
        .post("/api-keys", json!({ "name": " Laptop script " }))
        .await;
    assert_eq!(created.status, 201);
    let key = created.body["key"].as_str().unwrap().to_owned();
    assert!(key.starts_with("exp_") && key.len() == 47, "{key}");
    assert_eq!(created.body["prefix"], key[..12]);
    assert_eq!(created.body["name"], "Laptop script");
    assert_eq!(created.body["lastUsedAt"], Value::Null);
    assert_eq!(created.body["createdAt"], iso(now()));
    assert!(created.body.get("keyHash").is_none());

    let bearer = format!("Bearer {key}");
    let auth = [("authorization", bearer.as_str())];
    let me = app.request("GET", "/auth/me", None, &auth).await;
    assert_eq!(me.status, 200);
    assert_eq!(me.body["id"], 1);
    let expense = json!({ "amount": 5, "description": "From a script", "categoryId": 1 });
    assert_eq!(
        app.request("POST", "/expenses", Some(expense), &auth)
            .await
            .status,
        201
    );

    let listed = app.get("/api-keys").await.body;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["lastUsedAt"], iso(now()));
    assert!(listed[0].get("key").is_none());

    let forbidden = app.request("GET", "/api-keys", None, &auth).await;
    assert_eq!(forbidden.status, 403);
    assert_eq!(
        forbidden.body["message"],
        "This action requires logging in, not an API key"
    );
    assert_eq!(
        app.request("POST", "/api-keys", Some(json!({ "name": "x" })), &auth)
            .await
            .status,
        403
    );

    let other_user = [("cookie", "session_id=session-2")];
    assert_eq!(
        app.request("DELETE", "/api-keys/1", None, &other_user)
            .await
            .status,
        404
    );
    assert_eq!(app.delete("/api-keys/1").await.status, 204);
    assert_eq!(
        app.request("GET", "/auth/me", None, &auth).await.status,
        401
    );
    assert_eq!(app.delete("/api-keys/1").await.status, 404);
}

#[tokio::test]
async fn api_key_names_and_counts_are_limited() {
    let app = spawn().await;
    app.seed_users().await;
    assert_eq!(
        app.post("/api-keys", json!({ "name": "  " })).await.body["message"],
        "Name is required"
    );
    let long_name = json!({ "name": "x".repeat(51) });
    assert_eq!(
        app.post("/api-keys", long_name).await.body["message"],
        "Name must be at most 50 characters"
    );
    for i in 0..10 {
        assert_eq!(
            app.post("/api-keys", json!({ "name": format!("Key {i}") }))
                .await
                .status,
            201
        );
    }
    let response = app
        .post("/api-keys", json!({ "name": "One too many" }))
        .await;
    assert_eq!(response.status, 400);
    assert_eq!(response.body["message"], "You can have at most 10 API keys");
}

#[tokio::test]
async fn api_keys_record_their_last_use_at_most_once_a_minute() {
    let app = spawn().await;
    app.seed_users().await;
    let key = app.post("/api-keys", json!({ "name": "k" })).await.body["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let earlier = db::timestamp(now() - TimeDelta::seconds(30));
    app.db
        .execute("UPDATE ApiKey SET lastUsedAt = ?1", [earlier.as_str()])
        .await
        .unwrap();

    let bearer = format!("bearer {key}");
    assert_eq!(
        app.request("GET", "/auth/me", None, &[("authorization", &bearer)])
            .await
            .status,
        200
    );
    let mut rows = app
        .db
        .query("SELECT lastUsedAt FROM ApiKey", ())
        .await
        .unwrap();
    let last_used: String = rows.next().await.unwrap().unwrap().get(0).unwrap();
    assert_eq!(last_used, earlier);

    for invalid in ["Bearer exp_unknown", "Bearer ", "Basic abc", "exp_abc"] {
        let response = app
            .request("GET", "/auth/me", None, &[("authorization", invalid)])
            .await;
        assert_eq!(response.status, 401, "{invalid}");
    }
}

#[tokio::test]
async fn a_valid_session_takes_precedence_over_an_api_key() {
    let app = spawn().await;
    app.seed_users().await;
    let key = app.post("/api-keys", json!({ "name": "k" })).await.body["key"]
        .as_str()
        .unwrap()
        .to_owned();
    let bearer = format!("Bearer {key}");
    let response = app
        .request(
            "GET",
            "/auth/me",
            None,
            &[
                ("cookie", "session_id=session-2"),
                ("authorization", &bearer),
            ],
        )
        .await;
    assert_eq!(response.body["id"], 2);
    let stale_cookie = [
        ("cookie", "session_id=gone"),
        ("authorization", bearer.as_str()),
    ];
    assert_eq!(
        app.request("GET", "/auth/me", None, &stale_cookie)
            .await
            .body["id"],
        1
    );
}

#[tokio::test]
async fn http_plumbing() {
    let app = spawn().await;
    app.seed_users().await;

    let health = app.request("GET", "/health", None, &[]).await;
    assert_eq!(health.body, json!({ "message": "Hello World" }));

    let unknown = app.request("GET", "/nope", None, &[]).await;
    assert_eq!(unknown.status, 404);
    assert_eq!(unknown.body, json!({ "message": "Route not found" }));
    assert_eq!(
        app.get("/expenses/abc").await.body,
        json!({ "message": "Invalid id" })
    );

    let malformed = app
        .request(
            "POST",
            "/categories",
            None,
            &[USER_1, ("content-type", "application/json")],
        )
        .await;
    assert_eq!(malformed.status, 400);
    assert!(malformed.body["message"].is_string());

    let echoed = app
        .request("GET", "/health", None, &[("x-correlation-id", "abc-123")])
        .await;
    assert_eq!(echoed.header("x-correlation-id"), "abc-123");
    let generated = health.header("x-correlation-id");
    assert_eq!(generated.len(), 36, "{generated}");

    let preflight = app
        .request(
            "OPTIONS",
            "/expenses",
            None,
            &[
                ("origin", "http://localhost:4321"),
                ("access-control-request-method", "POST"),
                (
                    "access-control-request-headers",
                    "content-type,x-correlation-id",
                ),
            ],
        )
        .await;
    assert_eq!(
        preflight.header("access-control-allow-origin"),
        "http://localhost:4321"
    );
    assert_eq!(preflight.header("access-control-allow-credentials"), "true");
    assert!(
        preflight
            .header("access-control-allow-methods")
            .contains("PATCH")
    );
    assert_eq!(
        preflight.header("access-control-allow-headers"),
        "content-type,x-correlation-id"
    );

    let cors = app
        .request(
            "GET",
            "/expenses",
            None,
            &[USER_1, ("origin", "http://localhost:4321")],
        )
        .await;
    assert_eq!(
        cors.header("access-control-expose-headers"),
        "x-correlation-id"
    );
}

#[tokio::test]
async fn migrations_are_idempotent_and_recorded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.db");
    let path = path.to_str().unwrap();
    let first = db::open(path, "").await.unwrap();
    first.execute("INSERT INTO User (name, email, passwordHash, expendableAmountPerWeek, updatedAt) VALUES ('a', 'a@b.c', 'x', 1, ?1)", params![db::timestamp(now())]).await.unwrap();
    drop(first);

    let reopened = db::open(&format!("file:{path}"), "").await.unwrap();
    let mut rows = reopened
        .query(
            "SELECT (SELECT COUNT(*) FROM User), (SELECT COUNT(*) FROM _migrations)",
            (),
        )
        .await
        .unwrap();
    let row = rows.next().await.unwrap().unwrap();
    assert_eq!(
        (row.get::<i64>(0).unwrap(), row.get::<i64>(1).unwrap()),
        (1, 2)
    );
}
