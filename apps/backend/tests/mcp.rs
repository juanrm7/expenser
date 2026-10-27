//! The MCP server at `/mcp`: authentication, the protocol handshake, and every tool.

mod common;

use common::{TestApp, TestResponse, USER_1, spawn};
use serde_json::{Value, json};

/// Real clients always send a `Host`, which the MCP server requires.
const HOST: (&str, &str) = ("host", "localhost");
const ACCEPT: (&str, &str) = ("accept", "application/json, text/event-stream");
const PROTOCOL_VERSION: (&str, &str) = ("mcp-protocol-version", "2025-06-18");

/// The test app, and an `Authorization` header with an API key of user 1.
async fn setup() -> (TestApp, String) {
    let app = spawn().await;
    app.seed_users().await;
    let key = &app
        .post("/api-keys", json!({ "name": "Claude" }))
        .await
        .body["key"];
    let auth = format!("Bearer {}", key.as_str().unwrap());
    (app, auth)
}

async fn rpc(app: &TestApp, auth: &str, method: &str, params: Value) -> TestResponse {
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let headers = [("authorization", auth), HOST, ACCEPT, PROTOCOL_VERSION];
    app.request("POST", "/mcp", Some(body), &headers).await
}

/// Calls a tool, returning its JSON result, or the error message the model would read.
async fn call(app: &TestApp, auth: &str, tool: &str, arguments: Value) -> Result<Value, String> {
    let params = json!({ "name": tool, "arguments": arguments });
    let response = rpc(app, auth, "tools/call", params).await;
    assert_eq!(response.status, 200, "{}", response.body);
    let result = &response.body["result"];
    let text = result["content"][0]["text"].as_str().unwrap();
    if result["isError"] == true {
        Err(text.to_owned())
    } else {
        Ok(serde_json::from_str(text).unwrap())
    }
}

fn ids(expenses: &Value) -> Vec<i64> {
    expenses
        .as_array()
        .unwrap()
        .iter()
        .map(|expense| expense["id"].as_i64().unwrap())
        .collect()
}

#[tokio::test]
async fn only_api_keys_authenticate_and_the_handshake_lists_every_tool() {
    let (app, auth) = setup().await;
    let initialize = json!({
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": { "name": "test", "version": "1.0" }
    });

    for headers in [
        vec![],
        vec![USER_1],
        vec![("authorization", "Bearer exp_unknown")],
    ] {
        let body =
            json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": initialize });
        let headers = [headers, vec![HOST, ACCEPT]].concat();
        let response = app.request("POST", "/mcp", Some(body), &headers).await;
        assert_eq!(response.status, 401, "{headers:?}");
        assert_eq!(response.header("www-authenticate"), "Bearer");
        assert_eq!(response.body["message"], "Unauthorized");
    }

    let response = rpc(&app, &auth, "initialize", initialize).await;
    assert_eq!(response.status, 200, "{}", response.body);
    let result = &response.body["result"];
    assert_eq!(result["protocolVersion"], "2025-06-18");
    assert_eq!(result["serverInfo"]["name"], "expenser");
    assert!(result["capabilities"]["tools"].is_object());
    assert!(result["instructions"].as_str().unwrap().contains("ARS"));

    let initialized = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    let headers = [
        ("authorization", auth.as_str()),
        HOST,
        ACCEPT,
        PROTOCOL_VERSION,
    ];
    let response = app
        .request("POST", "/mcp", Some(initialized), &headers)
        .await;
    assert_eq!(response.status, 202);

    let tools = rpc(&app, &auth, "tools/list", json!({})).await.body;
    let mut names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "add_category",
            "add_expense",
            "delete_category",
            "delete_expense",
            "get_profile",
            "get_summary",
            "list_categories",
            "list_expenses",
            "update_category",
            "update_expense",
            "update_profile",
        ]
    );

    // Newer clients skip the handshake and send their protocol version with every request.
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "get_profile",
            "arguments": {},
            "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { "name": "test", "version": "1.0" },
                "io.modelcontextprotocol/clientCapabilities": {}
            }
        }
    });
    let headers = [
        ("authorization", auth.as_str()),
        HOST,
        ACCEPT,
        ("mcp-protocol-version", "2026-07-28"),
        ("mcp-method", "tools/call"),
        ("mcp-name", "get_profile"),
    ];
    let response = app.request("POST", "/mcp", Some(body), &headers).await;
    assert_eq!(response.status, 200, "{}", response.body);
    let text = response.body["result"]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(text).unwrap()["id"], 1);
}

#[tokio::test]
async fn expenses_are_added_by_category_name_updated_and_deleted() {
    let (app, auth) = setup().await;

    let added = call(
        &app,
        &auth,
        "add_expense",
        json!({ "amount": 4500, "description": "Taxi", "category": " transport " }),
    )
    .await
    .unwrap();
    assert_eq!(added["category"], "Transport");
    assert_eq!(added["date"], "2026-10-22");
    let rest = app.get(&format!("/expenses/{}", added["id"])).await.body;
    assert_eq!(rest["description"], "Taxi");
    assert_eq!(rest["amount"], 4500.0);

    let dated = call(
        &app,
        &auth,
        "add_expense",
        json!({ "amount": 1200, "description": "Coffee", "category": "Food", "date": "2026-10-20" }),
    )
    .await
    .unwrap();
    assert_eq!(dated["date"], "2026-10-20");

    for (arguments, message) in [
        (
            json!({ "amount": 1, "description": "x", "category": "Other user" }),
            "There is no category named \"Other user\". The user's categories are: Food, Transport",
        ),
        (
            json!({ "amount": 0, "description": "x", "category": "Food" }),
            "Amount must be greater than 0",
        ),
        (
            json!({ "amount": 1, "description": "x", "category": "Food", "date": "2026-10-23" }),
            "Enter a valid expense date on or before today (YYYY-MM-DD)",
        ),
    ] {
        let error = call(&app, &auth, "add_expense", arguments.clone()).await;
        assert_eq!(error, Err(message.to_owned()), "{arguments}");
    }
    let missing = call(&app, &auth, "add_expense", json!({ "amount": 1 })).await;
    assert!(missing.unwrap_err().contains("description"));

    let id = dated["id"].clone();
    let updated = call(
        &app,
        &auth,
        "update_expense",
        json!({ "id": id, "amount": 1500, "category": "TRANSPORT" }),
    )
    .await
    .unwrap();
    assert_eq!(updated["amount"], 1500.0);
    assert_eq!(updated["category"], "Transport");
    assert_eq!(updated["description"], "Coffee");
    assert_eq!(updated["date"], "2026-10-20");
    assert_eq!(
        call(&app, &auth, "update_expense", json!({ "id": id })).await,
        Err("Nothing to update".to_owned())
    );

    let other_users = app.seed_expense("2026-10-21T12:00:00", 900.0, 2).await;
    for tool in ["update_expense", "delete_expense"] {
        let error = call(&app, &auth, tool, json!({ "id": other_users, "amount": 1 })).await;
        assert_eq!(error, Err("Expense not found".to_owned()), "{tool}");
    }

    let deleted = call(&app, &auth, "delete_expense", json!({ "id": id }))
        .await
        .unwrap();
    assert_eq!(deleted["description"], "Coffee");
    assert_eq!(app.get(&format!("/expenses/{id}")).await.status, 404);
}

#[tokio::test]
async fn summaries_and_expense_searches_cover_the_requested_days_of_the_user() {
    let (app, auth) = setup().await;
    let add = async |amount: i64, description: &str, category: &str, date: &str| {
        let expense = json!({ "amount": amount, "description": description, "category": category, "date": date });
        let added = call(&app, &auth, "add_expense", expense).await.unwrap();
        added["id"].as_i64().unwrap()
    };
    let before = add(100, "Groceries", "Food", "2026-10-09").await;
    let first = add(200, "Taxi home", "Transport", "2026-10-10").await;
    let groceries = add(300, "Supermarket groceries", "Food", "2026-10-12").await;
    let taxi = add(400, "Taxi", "Transport", "2026-10-16").await;
    let after = add(800, "Dinner", "Food", "2026-10-17").await;
    let last = app.seed_expense("2026-10-16T23:59:59.999", 50.0, 1).await;
    app.seed_expense("2026-10-12T12:00:00", 900.0, 2).await;

    let week = json!({ "from": "2026-10-10", "to": "2026-10-16" });
    let list = call(&app, &auth, "list_expenses", week).await.unwrap();
    assert_eq!(list["count"], 4);
    assert_eq!(list["total"], 950.0);
    assert_eq!(
        list["byCategory"],
        json!([
            { "category": "Transport", "count": 2, "total": 600.0 },
            { "category": "Food", "count": 2, "total": 350.0 },
        ])
    );
    assert_eq!(ids(&list["expenses"]), [last, taxi, groceries, first]);
    assert_eq!(list["expenses"][0]["date"], "2026-10-16");

    let food = json!({ "category": "FOOD" });
    let list = call(&app, &auth, "list_expenses", food).await.unwrap();
    assert_eq!(ids(&list["expenses"]), [after, last, groceries, before]);
    let search = json!({ "search": "groceries" });
    let list = call(&app, &auth, "list_expenses", search).await.unwrap();
    assert_eq!(ids(&list["expenses"]), [groceries, before]);

    let newest = call(&app, &auth, "list_expenses", json!({ "limit": 1 }))
        .await
        .unwrap();
    assert_eq!(newest["count"], 6);
    assert_eq!(newest["total"], 1850.0);
    assert_eq!(ids(&newest["expenses"]), [after]);

    for (arguments, message) in [
        (
            json!({ "from": "2026-13-01" }),
            "from must be a date (YYYY-MM-DD)",
        ),
        (
            json!({ "to": "yesterday" }),
            "to must be a date (YYYY-MM-DD)",
        ),
        (
            json!({ "from": "2026-10-16", "to": "2026-10-10" }),
            "from must be on or before to",
        ),
    ] {
        let error = call(&app, &auth, "list_expenses", arguments.clone()).await;
        assert_eq!(error, Err(message.to_owned()), "{arguments}");
    }

    let current = call(&app, &auth, "get_summary", json!({})).await.unwrap();
    assert_eq!(current["weekStart"], "2026-10-17");
    assert_eq!(current["today"], "2026-10-22");
    assert_eq!(current["spent"], 800.0);
    assert_eq!(current["monthly"]["spent"], 1850.0);
    let past = json!({ "weekStart": "2026-10-10" });
    let past = call(&app, &auth, "get_summary", past).await.unwrap();
    assert_eq!(past["spent"], 950.0);
    assert_eq!(past["available"], 50.0);
    let error = call(
        &app,
        &auth,
        "get_summary",
        json!({ "weekStart": "2026-10-11" }),
    )
    .await;
    assert!(
        error
            .unwrap_err()
            .starts_with("weekStart must be a Saturday")
    );
}

#[tokio::test]
async fn categories_and_the_profile_are_managed_for_the_user() {
    let (app, auth) = setup().await;

    let categories = call(&app, &auth, "list_categories", json!({}))
        .await
        .unwrap();
    assert_eq!(ids(&categories), [1, 2]);

    let gym = json!({ "name": "Gym", "color": "#22c55e" });
    let added = call(&app, &auth, "add_category", gym).await.unwrap();
    assert_eq!(added["name"], "Gym");
    assert_eq!(added["userId"], 1);
    let id = added["id"].clone();
    let renamed = json!({ "id": id, "name": "Sports" });
    let renamed = call(&app, &auth, "update_category", renamed).await.unwrap();
    assert_eq!(renamed["name"], "Sports");
    assert_eq!(renamed["color"], "#22c55e");
    let deleted = call(&app, &auth, "delete_category", json!({ "id": id }))
        .await
        .unwrap();
    assert_eq!(deleted["name"], "Sports");
    assert_eq!(app.get(&format!("/categories/{id}")).await.status, 404);
    for tool in ["update_category", "delete_category"] {
        let error = call(&app, &auth, tool, json!({ "id": 3, "name": "Mine" })).await;
        assert_eq!(error, Err("Category not found".to_owned()), "{tool}");
    }

    let profile = call(&app, &auth, "get_profile", json!({})).await.unwrap();
    assert_eq!(profile["name"], "User 1");
    assert_eq!(profile["expendableAmountPerWeek"], 1000.0);
    let raise = json!({ "expendableAmountPerWeek": 2000 });
    let updated = call(&app, &auth, "update_profile", raise).await.unwrap();
    assert_eq!(updated["expendableAmountPerWeek"], 2000.0);
    assert_eq!(updated["name"], "User 1");
    let summary = call(&app, &auth, "get_summary", json!({})).await.unwrap();
    assert_eq!(summary["allowance"], 2000.0);
    let negative = json!({ "expendableAmountPerWeek": -1 });
    assert_eq!(
        call(&app, &auth, "update_profile", negative).await,
        Err("Invalid expendable amount".to_owned())
    );
}
