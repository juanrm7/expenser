//! Database access through libSQL: a local SQLite file in development, Turso in production.

use anyhow::Context;
use chrono::{DateTime, SecondsFormat, Utc};
use libsql::{Builder, Connection, Row, params, params::IntoParams};
use serde::Serializer;
use serde::de::value::{Error as ValueError, MapDeserializer};
use serde::de::{DeserializeOwned, IntoDeserializer};

/// Schema migrations, applied in order at startup. Append new files; never edit applied ones.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_oauth.sql"),
];

/// Connects to the database at `url` and applies any pending migrations.
pub async fn open(url: &str, auth_token: &str) -> anyhow::Result<Connection> {
    let db = if url.starts_with("libsql:") || url.starts_with("http") {
        Builder::new_remote(url.to_owned(), auth_token.to_owned())
            .build()
            .await
    } else {
        Builder::new_local(url.trim_start_matches("file:"))
            .build()
            .await
    }
    .with_context(|| format!("failed to open database {url}"))?;

    let conn = db.connect()?;
    migrate(&conn).await.context("failed to migrate database")?;
    Ok(conn)
}

async fn migrate(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL)",
        (),
    )
    .await?;
    let current: i64 = fetch_value(
        conn,
        "SELECT COALESCE(MAX(version), 0) FROM _migrations",
        (),
    )
    .await?;

    for (version, sql) in (1..).zip(MIGRATIONS).skip(usize::try_from(current)?) {
        let tx = conn.transaction().await?;
        tx.execute_batch(sql).await?;
        tx.execute(
            "INSERT INTO _migrations (version, appliedAt) VALUES (?1, ?2)",
            params![version, timestamp(Utc::now())],
        )
        .await?;
        tx.commit().await?;
        tracing::info!(version, "applied database migration");
    }
    Ok(())
}

/// Every row of a query, deserialized by column name.
pub async fn fetch_all<T: DeserializeOwned>(
    conn: &Connection,
    sql: &str,
    params: impl IntoParams,
) -> anyhow::Result<Vec<T>> {
    let mut rows = conn.query(sql, params).await?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().await? {
        items.push(from_row(&row)?);
    }
    Ok(items)
}

/// The first row of a query, if any, deserialized by column name.
pub async fn fetch_optional<T: DeserializeOwned>(
    conn: &Connection,
    sql: &str,
    params: impl IntoParams,
) -> anyhow::Result<Option<T>> {
    let mut rows = conn.query(sql, params).await?;
    match rows.next().await? {
        Some(row) => Ok(Some(from_row(&row)?)),
        None => Ok(None),
    }
}

/// The row of a query that always returns one, like `INSERT … RETURNING *`.
pub async fn fetch_one<T: DeserializeOwned>(
    conn: &Connection,
    sql: &str,
    params: impl IntoParams,
) -> anyhow::Result<T> {
    fetch_optional(conn, sql, params)
        .await?
        .context("query returned no rows")
}

/// The single value of a query like `SELECT COUNT(*) …`.
pub async fn fetch_value<T: DeserializeOwned>(
    conn: &Connection,
    sql: &str,
    params: impl IntoParams,
) -> anyhow::Result<T> {
    let mut rows = conn.query(sql, params).await?;
    let row = rows.next().await?.context("query returned no rows")?;
    let value = IntoDeserializer::<ValueError>::into_deserializer(row.get_value(0)?);
    Ok(T::deserialize(value)?)
}

/// Deserializes a row by column name. Unlike `libsql::de::from_row`, supports `#[serde(flatten)]`.
fn from_row<T: DeserializeOwned>(row: &Row) -> anyhow::Result<T> {
    let mut columns = Vec::new();
    for i in 0..row.column_count() {
        columns.push((
            row.column_name(i).context("unnamed column")?,
            row.get_value(i)?,
        ));
    }
    Ok(T::deserialize(MapDeserializer::<_, ValueError>::new(
        columns.into_iter(),
    ))?)
}

/// Encodes an instant for storage. Timestamps are UTC text in the fixed-width format the previous
/// (Prisma) backend wrote, `2026-10-12T03:00:00.000+00:00`, so comparing them as strings orders them.
pub fn timestamp(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Millis, false)
}

/// Serializes a row timestamp for API responses like JavaScript's `toISOString()`:
/// `2026-10-12T03:00:00.000Z`.
pub fn to_json<S: Serializer>(instant: &DateTime<Utc>, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.collect_str(&instant.format("%Y-%m-%dT%H:%M:%S%.3fZ"))
}

/// [`to_json`] for optional timestamps.
pub fn to_json_opt<S: Serializer>(
    instant: &Option<DateTime<Utc>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match instant {
        Some(instant) => to_json(instant, serializer),
        None => serializer.serialize_none(),
    }
}
