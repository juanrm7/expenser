//! Expense and weekly/monthly summary regression tests.

mod common;

use common::{TestApp, iso, local, now, spawn};
use serde_json::{Value, json};

async fn setup() -> TestApp {
    let app = spawn().await;
    app.seed_users().await;
    app
}

fn pluck<'a>(expenses: &'a Value, field: &str) -> Vec<&'a Value> {
    expenses
        .as_array()
        .unwrap()
        .iter()
        .map(|expense| &expense[field])
        .collect()
}

#[tokio::test]
async fn historical_summary_includes_saturday_through_friday_only_and_is_scoped_to_the_user() {
    let app = setup().await;
    app.seed_expense("2026-10-09T23:59:59.999", 5.0, 1).await;
    let first = app.seed_expense("2026-10-10T00:00:00", 100.0, 1).await;
    let last = app.seed_expense("2026-10-16T23:59:59.999", 200.0, 1).await;
    app.seed_expense("2026-10-17T00:00:00", 400.0, 1).await;
    app.seed_expense("2026-10-12T12:00:00", 900.0, 2).await;

    let response = app.get("/expenses/summary?weekStart=2026-10-10").await;
    assert_eq!(response.status, 200);
    let summary = response.body;
    assert_eq!(summary["weekStart"], "2026-10-10");
    assert_eq!(summary["currentWeekStart"], "2026-10-17");
    assert_eq!(summary["today"], "2026-10-22");
    assert_eq!(
        pluck(&summary["expenses"], "id"),
        [&json!(last), &json!(first)]
    );
    assert_eq!(
        pluck(&summary["expenses"], "date"),
        [&json!("2026-10-16"), &json!("2026-10-10")]
    );
    assert_eq!(summary["spent"], 300.0);
    assert_eq!(summary["available"], 700.0);
    assert_eq!(summary["monthly"]["spent"], 705.0);
}

#[tokio::test]
async fn default_summary_shows_the_current_week_and_empty_weeks_have_zero_spent() {
    let app = setup().await;
    app.seed_expense("2026-10-16T12:00:00", 100.0, 1).await;
    app.seed_expense("2026-10-17T12:00:00", 200.0, 1).await;

    let current = app.get("/expenses/summary").await.body;
    assert_eq!(current["weekStart"], "2026-10-17");
    assert_eq!(current["spent"], 200.0);
    assert_eq!(current["monthly"]["monthStart"], "2026-10-01");
    assert_eq!(current["monthly"]["allowance"], 1000.0 / 7.0 * 31.0);

    let empty = app.get("/expenses/summary?weekStart=2026-01-03").await.body;
    assert_eq!(empty["expenses"], json!([]));
    assert_eq!(empty["spent"], 0.0);
    assert_eq!(empty["available"], 1000.0);
}

#[tokio::test]
async fn invalid_non_saturday_and_future_weeks_are_rejected() {
    let app = setup().await;
    for value in ["invalid", "", "2026-02-30", "2026-10-11", "2026-10-24"] {
        let response = app
            .get(&format!("/expenses/summary?weekStart={value}"))
            .await;
        assert_eq!(response.status, 400, "weekStart={value}");
    }
}

#[tokio::test]
async fn a_missed_expense_can_be_created_edited_and_deleted_while_browsing_a_past_week() {
    let app = setup().await;
    let created = app
        .post("/expenses", json!({ "amount": 100, "description": "Missed lunch", "categoryId": 1, "date": "2026-10-12" }))
        .await;
    assert_eq!(created.status, 201);
    let expense = created.body;
    assert_eq!(expense["createdAt"], iso(local("2026-10-12T00:00:00")));
    assert_eq!(expense["category"], "Food");
    assert_eq!(expense["userId"], 1);

    let id = &expense["id"];
    let edited = app
        .patch(
            &format!("/expenses/{id}"),
            json!({ "amount": 150, "description": "Corrected lunch", "categoryId": 2 }),
        )
        .await;
    assert_eq!(edited.status, 200);
    assert_eq!(edited.body["category"], "Transport");
    assert_eq!(edited.body["createdAt"], expense["createdAt"]);

    let summary = app.get("/expenses/summary?weekStart=2026-10-10").await.body;
    assert_eq!(summary["spent"], 150.0);
    assert_eq!(summary["monthly"]["spent"], 150.0);
    assert_eq!(summary["expenses"][0]["description"], "Corrected lunch");
    assert_eq!(app.get("/expenses/summary").await.body["spent"], 0.0);

    assert_eq!(app.delete(&format!("/expenses/{id}")).await.status, 204);
    assert_eq!(
        app.get("/expenses/summary?weekStart=2026-10-10").await.body["spent"],
        0.0
    );
    assert_eq!(app.get(&format!("/expenses/{id}")).await.status, 404);
}

#[tokio::test]
async fn editing_keeps_a_deleted_category_and_changing_the_date_moves_the_expense_between_weeks() {
    let app = setup().await;
    app.db
        .execute(
            "INSERT INTO Expense (id, description, amount, category, createdAt, updatedAt, userId)
             VALUES (1000, 'Old expense', 100, 'Deleted category', ?1, ?1, 1)",
            [expenser_backend::db::timestamp(local(
                "2026-09-30T12:00:00",
            ))],
        )
        .await
        .unwrap();

    let response = app
        .patch(
            "/expenses/1000",
            json!({ "amount": 125, "date": "2026-10-12" }),
        )
        .await;
    assert_eq!(response.status, 200);
    assert_eq!(response.body["category"], "Deleted category");
    assert_eq!(
        app.get("/expenses/summary?weekStart=2026-09-26").await.body["spent"],
        0.0
    );
    let summary = app.get("/expenses/summary?weekStart=2026-10-10").await.body;
    assert_eq!(summary["spent"], 125.0);
    assert_eq!(summary["monthly"]["spent"], 125.0);
}

#[tokio::test]
async fn creating_without_a_date_records_the_expense_now() {
    let app = setup().await;
    let response = app
        .post(
            "/expenses",
            json!({ "amount": 10, "description": "", "categoryId": 1 }),
        )
        .await;
    assert_eq!(response.status, 201);
    assert_eq!(response.body["createdAt"], iso(now()));
    assert_eq!(response.body["updatedAt"], iso(now()));
}

#[tokio::test]
async fn invalid_dates_and_non_positive_amounts_cannot_be_created_or_saved() {
    let app = setup().await;
    let id = app.seed_expense("2026-10-12T12:00:00", 100.0, 1).await;
    for change in [
        json!({ "date": "2026-02-30" }),
        json!({ "date": "2026-10-23" }),
        json!({ "date": "invalid" }),
        json!({ "amount": 0 }),
        json!({ "amount": -10 }),
    ] {
        let mut payload = json!({ "amount": 10, "description": "", "categoryId": 1 });
        payload
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert_eq!(
            app.post("/expenses", payload).await.status,
            400,
            "create with {change}"
        );
        assert_eq!(
            app.patch(&format!("/expenses/{id}"), change.clone())
                .await
                .status,
            400,
            "update with {change}"
        );
    }
    assert_eq!(
        app.patch(&format!("/expenses/{id}"), json!({}))
            .await
            .status,
        400
    );
    let missing_field = app
        .post("/expenses", json!({ "amount": 10, "categoryId": 1 }))
        .await;
    assert_eq!(missing_field.status, 400);
    assert!(
        missing_field.body["message"]
            .as_str()
            .unwrap()
            .contains("description")
    );
}

#[tokio::test]
async fn expenses_and_category_ids_of_another_user_cannot_be_used() {
    let app = setup().await;
    let id = app.seed_expense("2026-10-12T12:00:00", 100.0, 2).await;
    assert_eq!(app.get(&format!("/expenses/{id}")).await.status, 404);
    assert_eq!(
        app.patch(&format!("/expenses/{id}"), json!({ "amount": 1 }))
            .await
            .status,
        404
    );
    assert_eq!(app.delete(&format!("/expenses/{id}")).await.status, 404);
    let foreign_category = app
        .post(
            "/expenses",
            json!({ "amount": 1, "description": "", "categoryId": 3, "date": "2026-10-12" }),
        )
        .await;
    assert_eq!(foreign_category.status, 404);
    assert_eq!(foreign_category.body["message"], "Category not found");
    assert_eq!(app.get("/expenses").await.body, json!([]));

    let anonymous = app
        .request("GET", "/expenses/summary?weekStart=2026-10-10", None, &[])
        .await;
    assert_eq!(anonymous.status, 401);
    assert_eq!(anonymous.body, json!({ "message": "Unauthorized" }));
}

#[tokio::test]
async fn expenses_are_listed_newest_first() {
    let app = setup().await;
    let older = app.seed_expense("2026-10-01T09:00:00", 1.0, 1).await;
    let newer = app.seed_expense("2026-10-20T09:00:00", 2.0, 1).await;
    assert_eq!(
        pluck(&app.get("/expenses").await.body, "id"),
        [&json!(newer), &json!(older)]
    );
}
