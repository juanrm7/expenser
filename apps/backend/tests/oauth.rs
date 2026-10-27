//! OAuth for the MCP server: discovery, client registration, the authorization code flow with
//! PKCE, refresh token rotation, and connections.

mod common;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use common::{TestApp, TestResponse, iso, now, spawn};
use expenser_backend::db;
use libsql::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

const REDIRECT_URI: &str = "https://claude.ai/api/mcp/auth_callback";
const RESOURCE: &str = "https://api.example.com/mcp";
const VERIFIER: &str = "a-pkce-code-verifier-of-at-least-43-characters";

async fn setup() -> TestApp {
    let app = spawn().await;
    app.seed_users().await;
    app
}

async fn register(app: &TestApp, redirect_uris: Value) -> TestResponse {
    let body = json!({ "client_name": "Claude", "redirect_uris": redirect_uris });
    app.request("POST", "/oauth/register", Some(body), &[])
        .await
}

async fn client_id(app: &TestApp, redirect_uri: &str) -> String {
    let response = register(app, json!([redirect_uri])).await;
    assert_eq!(response.status, 201, "{}", response.body);
    response.body["client_id"].as_str().unwrap().to_owned()
}

/// The query of an authorization request, with these parameters changed (`None` removes one).
fn authorize_query(client_id: &str, changes: &[(&str, Option<&str>)]) -> String {
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(VERIFIER));
    let mut params = vec![
        ("response_type", Some("code")),
        ("client_id", Some(client_id)),
        ("redirect_uri", Some(REDIRECT_URI)),
        ("code_challenge", Some(challenge.as_str())),
        ("code_challenge_method", Some("S256")),
        ("state", Some("xyz")),
        ("resource", Some(RESOURCE)),
        ("scope", Some("offline_access")),
    ];
    for (name, value) in changes {
        match params.iter_mut().find(|(param, _)| param == name) {
            Some(param) => param.1 = *value,
            None => params.push((name, *value)),
        }
    }
    let present = params
        .into_iter()
        .filter_map(|(name, value)| Some((name, value?)));
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(present)
        .finish()
}

/// A query parameter of a URL.
fn param(url: &str, name: &str) -> Option<String> {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// User 1 approves the request, returning the code it was redirected with.
async fn approve(app: &TestApp, query: &str) -> String {
    let uri = format!("/oauth/consent?{query}");
    let response = app.post(&uri, json!({ "approve": true })).await;
    assert_eq!(response.status, 200, "{}", response.body);
    let redirect_to = response.body["redirectTo"].as_str().unwrap();
    assert_eq!(param(redirect_to, "state").as_deref(), Some("xyz"));
    param(redirect_to, "code").unwrap()
}

async fn exchange(app: &TestApp, client_id: &str, code: &str, verifier: &str) -> TestResponse {
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("redirect_uri", REDIRECT_URI),
        ("code_verifier", verifier),
        ("resource", RESOURCE),
    ];
    app.post_form("/oauth/token", &form).await
}

async fn refresh(app: &TestApp, client_id: &str, refresh_token: &str) -> TestResponse {
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", client_id),
        ("refresh_token", refresh_token),
    ];
    app.post_form("/oauth/token", &form).await
}

/// Registers a client and connects user 1 to it, returning the client id and the tokens.
async fn connect(app: &TestApp) -> (String, Value) {
    let client_id = client_id(app, REDIRECT_URI).await;
    let code = approve(app, &authorize_query(&client_id, &[])).await;
    let response = exchange(app, &client_id, &code, VERIFIER).await;
    assert_eq!(response.status, 200, "{}", response.body);
    (client_id, response.body)
}

/// The status of an MCP request authenticated with `token`, and the user id it saw.
async fn mcp_user(app: &TestApp, token: &Value) -> (u16, Value) {
    let auth = format!("Bearer {}", token.as_str().unwrap());
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "get_profile", "arguments": {} }
    });
    let headers = [
        ("authorization", auth.as_str()),
        ("host", "localhost"),
        ("accept", "application/json, text/event-stream"),
        ("mcp-protocol-version", "2025-06-18"),
    ];
    let response = app.request("POST", "/mcp", Some(body), &headers).await;
    let text = response.body["result"]["content"][0]["text"].as_str();
    let id = text.map_or(Value::Null, |text| {
        serde_json::from_str::<Value>(text).unwrap()["id"].clone()
    });
    (response.status.as_u16(), id)
}

fn error(response: &TestResponse) -> (u16, &str) {
    (
        response.status.as_u16(),
        response.body["error"].as_str().unwrap(),
    )
}

#[tokio::test]
async fn discovery_metadata_points_clients_at_every_endpoint() {
    let app = setup().await;
    for path in [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
    ] {
        let resource = app.request("GET", path, None, &[]).await.body;
        assert_eq!(resource["resource"], RESOURCE, "{path}");
        assert_eq!(
            resource["authorization_servers"],
            json!(["https://api.example.com"])
        );
    }

    let server = app
        .request("GET", "/.well-known/oauth-authorization-server", None, &[])
        .await
        .body;
    assert_eq!(server["issuer"], "https://api.example.com");
    for (field, path) in [
        ("authorization_endpoint", "/oauth/authorize"),
        ("token_endpoint", "/oauth/token"),
        ("registration_endpoint", "/oauth/register"),
    ] {
        assert_eq!(server[field], format!("https://api.example.com{path}"));
    }
    assert_eq!(server["code_challenge_methods_supported"], json!(["S256"]));
    assert_eq!(
        server["token_endpoint_auth_methods_supported"],
        json!(["none"])
    );
}

#[tokio::test]
async fn clients_register_https_or_loopback_redirect_uris() {
    let app = setup().await;

    let response = register(
        &app,
        json!([REDIRECT_URI, "http://localhost:3118/callback"]),
    )
    .await;
    assert_eq!(response.status, 201, "{}", response.body);
    let client = &response.body;
    assert!(client["client_id"].as_str().unwrap().len() >= 43);
    assert_eq!(client["client_name"], "Claude");
    assert_eq!(client["token_endpoint_auth_method"], "none");
    assert_eq!(client["client_id_issued_at"], now().timestamp());
    assert_eq!(
        client["redirect_uris"],
        json!([REDIRECT_URI, "http://localhost:3118/callback"])
    );

    let unnamed = json!({ "redirect_uris": [REDIRECT_URI], "token_endpoint_auth_method": "client_secret_basic" });
    let response = app
        .request("POST", "/oauth/register", Some(unnamed), &[])
        .await;
    assert_eq!(response.body["client_name"], "claude.ai");
    assert_eq!(response.body["token_endpoint_auth_method"], "none");

    let eleven: Vec<&str> = vec![REDIRECT_URI; 11];
    for redirect_uris in [
        json!([]),
        json!(eleven),
        json!(["http://example.com/callback"]),
        json!(["https://claude.ai/callback#fragment"]),
        json!(["javascript:alert(1)"]),
        json!([REDIRECT_URI, "not a url"]),
    ] {
        let response = register(&app, redirect_uris.clone()).await;
        assert_eq!(
            error(&response),
            (400, "invalid_redirect_uri"),
            "{redirect_uris}"
        );
    }
    let response = app
        .request(
            "POST",
            "/oauth/register",
            None,
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(error(&response), (400, "invalid_client_metadata"));
}

#[tokio::test]
async fn authorization_requests_are_checked_before_reaching_the_consent_page() {
    let app = setup().await;
    let client_id = client_id(&app, REDIRECT_URI).await;

    let query = authorize_query(&client_id, &[]);
    let response = app
        .request("GET", &format!("/oauth/authorize?{query}"), None, &[])
        .await;
    assert_eq!(response.status, 303);
    assert_eq!(
        response.header("location"),
        format!("http://localhost:4321/authorize?{query}")
    );

    // Until the client and redirect URI check out, nothing is sent to the redirect URI.
    for changes in [
        [("client_id", Some("unknown"))],
        [("client_id", None)],
        [("redirect_uri", Some("https://claude.ai/elsewhere"))],
        [("redirect_uri", None)],
    ] {
        let query = authorize_query(&client_id, &changes);
        let response = app
            .request("GET", &format!("/oauth/authorize?{query}"), None, &[])
            .await;
        assert_eq!(response.status, 400, "{changes:?}");
        assert_eq!(
            response.body["message"],
            "This sign-in link is invalid: unknown app or redirect"
        );
    }

    for (changes, expected) in [
        (
            vec![("response_type", Some("token"))],
            "unsupported_response_type",
        ),
        (vec![("code_challenge", None)], "invalid_request"),
        (vec![("code_challenge", Some("short"))], "invalid_request"),
        (
            vec![("code_challenge_method", Some("plain"))],
            "invalid_request",
        ),
        (vec![("code_challenge_method", None)], "invalid_request"),
        (
            vec![("resource", Some("https://elsewhere.example.com/mcp"))],
            "invalid_target",
        ),
    ] {
        let query = authorize_query(&client_id, &changes);
        let response = app
            .request("GET", &format!("/oauth/authorize?{query}"), None, &[])
            .await;
        assert_eq!(response.status, 303, "{changes:?}");
        let location = response.header("location");
        assert!(location.starts_with(REDIRECT_URI), "{location}");
        assert_eq!(
            param(location, "error").as_deref(),
            Some(expected),
            "{changes:?}"
        );
        assert_eq!(param(location, "state").as_deref(), Some("xyz"));
    }
}

#[tokio::test]
async fn loopback_redirect_uris_match_on_any_port() {
    let app = setup().await;
    let client_id = client_id(&app, "http://localhost:3118/callback").await;
    for (redirect_uri, status) in [
        ("http://localhost:3118/callback", 303),
        ("http://localhost:54321/callback", 303),
        ("http://localhost:54321/other", 400),
        ("http://127.0.0.1:3118/callback", 400),
        ("https://localhost:3118/callback", 400),
    ] {
        let query = authorize_query(&client_id, &[("redirect_uri", Some(redirect_uri))]);
        let response = app
            .request("GET", &format!("/oauth/authorize?{query}"), None, &[])
            .await;
        assert_eq!(response.status, status, "{redirect_uri}");
    }

    let query = authorize_query(
        &client_id,
        &[("redirect_uri", Some("http://localhost:54321/callback"))],
    );
    let uri = format!("/oauth/consent?{query}");
    let redirect_to = app.post(&uri, json!({ "approve": true })).await.body["redirectTo"].clone();
    assert!(
        redirect_to
            .as_str()
            .unwrap()
            .starts_with("http://localhost:54321/callback?code=")
    );
}

#[tokio::test]
async fn only_a_logged_in_user_approves_or_denies_on_the_consent_page() {
    let app = setup().await;
    let client_id = client_id(&app, REDIRECT_URI).await;
    let query = authorize_query(&client_id, &[]);
    let uri = format!("/oauth/consent?{query}");

    assert_eq!(app.request("GET", &uri, None, &[]).await.status, 401);
    let key = app.post("/api-keys", json!({ "name": "k" })).await.body["key"].clone();
    let bearer = format!("Bearer {}", key.as_str().unwrap());
    let with_key = [("authorization", bearer.as_str())];
    assert_eq!(app.request("GET", &uri, None, &with_key).await.status, 403);
    let approve_with_key = app
        .request("POST", &uri, Some(json!({ "approve": true })), &with_key)
        .await;
    assert_eq!(approve_with_key.status, 403);

    let request = app.get(&uri).await;
    assert_eq!(request.status, 200);
    assert_eq!(
        request.body,
        json!({ "clientName": "Claude", "redirectUri": REDIRECT_URI })
    );

    let denied = app.post(&uri, json!({ "approve": false })).await.body;
    let redirect_to = denied["redirectTo"].as_str().unwrap();
    assert_eq!(
        param(redirect_to, "error").as_deref(),
        Some("access_denied")
    );
    assert_eq!(param(redirect_to, "state").as_deref(), Some("xyz"));
    assert_eq!(param(redirect_to, "code"), None);

    let tampered = format!(
        "/oauth/consent?{}",
        authorize_query(&client_id, &[("code_challenge", None)])
    );
    let response = app.get(&tampered).await;
    assert_eq!(response.status, 400);
    assert!(response.body["message"].as_str().unwrap().contains("PKCE"));
}

#[tokio::test]
async fn codes_are_exchanged_once_with_their_verifier_client_and_redirect_uri() {
    let app = setup().await;
    let client_id = client_id(&app, REDIRECT_URI).await;
    let other_client = self::client_id(&app, REDIRECT_URI).await;
    let query = authorize_query(&client_id, &[]);

    let code = approve(&app, &query).await;
    let wrong_verifier = exchange(&app, &client_id, &code, &"x".repeat(43)).await;
    assert_eq!(error(&wrong_verifier), (400, "invalid_grant"));
    // A failed attempt uses the code up too.
    assert_eq!(
        error(&exchange(&app, &client_id, &code, VERIFIER).await),
        (400, "invalid_grant")
    );

    let code = approve(&app, &query).await;
    assert_eq!(
        error(&exchange(&app, &other_client, &code, VERIFIER).await),
        (400, "invalid_grant")
    );
    let code = approve(&app, &query).await;
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id.as_str()),
        ("code", code.as_str()),
        ("redirect_uri", "https://claude.ai/elsewhere"),
        ("code_verifier", VERIFIER),
    ];
    assert_eq!(
        error(&app.post_form("/oauth/token", &form).await),
        (400, "invalid_grant")
    );

    let code = approve(&app, &query).await;
    app.db
        .execute(
            "UPDATE OAuthCode SET expiresAt = ?1",
            params![db::timestamp(now())],
        )
        .await
        .unwrap();
    assert_eq!(
        error(&exchange(&app, &client_id, &code, VERIFIER).await),
        (400, "invalid_grant")
    );

    let code = approve(&app, &query).await;
    let response = exchange(&app, &client_id, &code, VERIFIER).await;
    assert_eq!(response.status, 200, "{}", response.body);
    assert_eq!(response.header("cache-control"), "no-store");
    let tokens = &response.body;
    assert!(tokens["access_token"].as_str().unwrap().starts_with("exa_"));
    assert!(
        tokens["refresh_token"]
            .as_str()
            .unwrap()
            .starts_with("exr_")
    );
    assert_eq!(tokens["token_type"], "Bearer");
    assert_eq!(tokens["expires_in"], 3600);
    assert_eq!(
        error(&exchange(&app, &client_id, &code, VERIFIER).await),
        (400, "invalid_grant")
    );

    for (form, expected) in [
        (
            vec![("grant_type", "password"), ("client_id", "x")],
            "unsupported_grant_type",
        ),
        (
            vec![("grant_type", "authorization_code")],
            "invalid_request",
        ),
        (
            vec![
                ("grant_type", "refresh_token"),
                ("client_id", client_id.as_str()),
            ],
            "invalid_request",
        ),
        (
            vec![
                ("grant_type", "authorization_code"),
                ("client_id", client_id.as_str()),
                ("resource", "https://elsewhere.example.com/mcp"),
            ],
            "invalid_target",
        ),
    ] {
        let response = app.post_form("/oauth/token", &form).await;
        assert_eq!(error(&response), (400, expected), "{form:?}");
    }
    let json_body = app
        .request(
            "POST",
            "/oauth/token",
            Some(json!({ "grant_type": "refresh_token" })),
            &[],
        )
        .await;
    assert_eq!(error(&json_body), (400, "invalid_request"));
}

#[tokio::test]
async fn access_tokens_work_on_mcp_only_and_refreshing_rotates_both_tokens() {
    let app = setup().await;
    let (client_id, tokens) = connect(&app).await;
    let access = &tokens["access_token"];
    let refresh_token = tokens["refresh_token"].as_str().unwrap();

    assert_eq!(mcp_user(&app, access).await, (200, json!(1)));
    let bearer = format!("Bearer {}", access.as_str().unwrap());
    let me = app
        .request(
            "GET",
            "/auth/me",
            None,
            &[("authorization", bearer.as_str())],
        )
        .await;
    assert_eq!(me.status, 401);

    let other_client = self::client_id(&app, REDIRECT_URI).await;
    assert_eq!(
        error(&refresh(&app, &other_client, refresh_token).await),
        (400, "invalid_grant")
    );

    let refreshed = refresh(&app, &client_id, refresh_token).await;
    assert_eq!(refreshed.status, 200, "{}", refreshed.body);
    let new_access = &refreshed.body["access_token"];
    assert_ne!(new_access, access);
    assert_eq!(mcp_user(&app, new_access).await, (200, json!(1)));
    assert_eq!(mcp_user(&app, access).await.0, 401);
    assert_eq!(
        error(&refresh(&app, &client_id, refresh_token).await),
        (400, "invalid_grant")
    );

    app.db
        .execute(
            "UPDATE OAuthGrant SET accessExpiresAt = ?1",
            params![db::timestamp(now())],
        )
        .await
        .unwrap();
    assert_eq!(mcp_user(&app, new_access).await.0, 401);
    let new_refresh = refreshed.body["refresh_token"].as_str().unwrap();
    let again = refresh(&app, &client_id, new_refresh).await;
    assert_eq!(
        mcp_user(&app, &again.body["access_token"]).await,
        (200, json!(1))
    );

    app.db
        .execute(
            "UPDATE OAuthGrant SET refreshExpiresAt = ?1",
            params![db::timestamp(now())],
        )
        .await
        .unwrap();
    let expired = again.body["refresh_token"].as_str().unwrap();
    assert_eq!(
        error(&refresh(&app, &client_id, expired).await),
        (400, "invalid_grant")
    );
}

#[tokio::test]
async fn users_list_and_revoke_their_connections() {
    let app = setup().await;
    let (client_id, tokens) = connect(&app).await;
    assert_eq!(mcp_user(&app, &tokens["access_token"]).await.0, 200);

    let listed = app.get("/oauth/connections").await;
    assert_eq!(listed.status, 200);
    assert_eq!(
        listed.body,
        json!([{ "id": 1, "clientName": "Claude", "lastUsedAt": iso(now()), "createdAt": iso(now()) }])
    );
    let user_2 = [("cookie", "session_id=session-2")];
    let others = app
        .request("GET", "/oauth/connections", None, &user_2)
        .await;
    assert_eq!(others.body, json!([]));
    let gone = app
        .request("DELETE", "/oauth/connections/1", None, &user_2)
        .await;
    assert_eq!(gone.status, 404);
    assert_eq!(gone.body["message"], "Connection not found");

    assert_eq!(app.delete("/oauth/connections/1").await.status, 204);
    assert_eq!(mcp_user(&app, &tokens["access_token"]).await.0, 401);
    let refresh_token = tokens["refresh_token"].as_str().unwrap();
    assert_eq!(
        error(&refresh(&app, &client_id, refresh_token).await),
        (400, "invalid_grant")
    );
    assert_eq!(app.get("/oauth/connections").await.body, json!([]));
    assert_eq!(app.delete("/oauth/connections/1").await.status, 404);

    connect(&app).await;
    app.db
        .execute(
            "UPDATE OAuthGrant SET refreshExpiresAt = ?1",
            params![db::timestamp(now())],
        )
        .await
        .unwrap();
    assert_eq!(app.get("/oauth/connections").await.body, json!([]));
    let key = app.post("/api-keys", json!({ "name": "k" })).await.body["key"].clone();
    let bearer = format!("Bearer {}", key.as_str().unwrap());
    let with_key = app
        .request(
            "GET",
            "/oauth/connections",
            None,
            &[("authorization", bearer.as_str())],
        )
        .await;
    assert_eq!(with_key.status, 403);
}
