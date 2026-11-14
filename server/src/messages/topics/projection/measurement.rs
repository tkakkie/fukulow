//! Manual #326 probe: migrate and seed load/hot-plans/seed.sql first. Supply a
//! throwaway fukulow_app DATABASE_URL, then run this ignored test in release mode.
use super::*;
use sqlx::{Connection, postgres::PgPoolOptions};
use std::time::Instant;

async fn page(
    connection: &mut sqlx::PgConnection,
    sql: &str,
    persistent: bool,
    topic: Option<Uuid>,
    member: Uuid,
    channel: Uuid,
) -> Vec<sqlx::postgres::PgRow> {
    sqlx::query(sql)
        .persistent(persistent)
        .bind(
            "00000000-0000-4000-8000-00000000000a"
                .parse::<Uuid>()
                .unwrap(),
        )
        .bind(member)
        .bind(0_i64)
        .bind(channel)
        .bind(100000_i64)
        .bind(None::<i64>)
        .bind(if topic.is_some() { 2_i64 } else { 51_i64 })
        .bind(topic.is_some())
        .bind(topic)
        .fetch_all(connection)
        .await
        .unwrap()
}

#[tokio::test]
#[ignore = "manual #326 release probe on the seeded throwaway database"]
async fn measure_timeline_plan_cache() {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    let mut connection = pool.acquire().await.unwrap();
    let (role, bypass): (String, bool) = sqlx::query_as(
        "SELECT current_user::text, rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user",
    ).fetch_one(&mut *connection).await.unwrap();
    assert_eq!(role, "fukulow_app");
    assert!(!bypass);
    let (member, channel, topic): (Uuid, Uuid, Uuid) = sqlx::query_as(
        "SELECT md5('user-a-2')::uuid, md5('chan-a-1')::uuid, md5('topic-a-1-7')::uuid",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    let sql = page_sql();
    for (label, mode, persistent) in [
        ("before", "auto", true),
        ("custom", "force_custom_plan", true),
        ("after", "auto", false),
    ] {
        connection.clear_cached_statements().await.unwrap();
        sqlx::raw_sql(&format!("SET plan_cache_mode={mode}"))
            .execute(&mut *connection)
            .await
            .unwrap();
        for (variant, topic) in [("latest", None), ("topic", Some(topic))] {
            sqlx::raw_sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
                .execute(&mut *connection)
                .await
                .unwrap();
            crate::database::set_organization(
                &mut connection,
                "00000000-0000-4000-8000-00000000000a".parse().unwrap(),
            )
            .await
            .unwrap();
            for _ in 0..10 {
                page(&mut connection, &sql, persistent, topic, member, channel).await;
            }
            let mut samples = Vec::new();
            for _ in 0..30 {
                let start = Instant::now();
                let rows = page(&mut connection, &sql, persistent, topic, member, channel).await;
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
                assert_eq!(rows.len(), if topic.is_some() { 1 } else { 51 });
                assert_eq!(rows[0].get::<Option<bool>, _>("visible"), Some(true));
            }
            samples.sort_by(f64::total_cmp);
            let cached: Vec<(String, i64, i64)> = sqlx::query_as(
                "SELECT name, generic_plans, custom_plans FROM pg_prepared_statements WHERE statement=$1",
            ).bind(&sql).fetch_all(&mut *connection).await.unwrap();
            eprintln!(
                "PLAN_CACHE {label} {variant} n=30 p50_ms={:.3} p95_ms={:.3} cached={cached:?}",
                samples[14], samples[28]
            );
            if label == "before" {
                assert!(cached[0].1 >= 30);
            }
            if label == "after" {
                assert!(cached.is_empty());
            }
            let explain = if persistent {
                format!(
                    "EXPLAIN (ANALYZE, BUFFERS) EXECUTE {} ('00000000-0000-4000-8000-00000000000a', '{member}', 0, '{channel}', 100000, NULL, {}, {}, {})",
                    cached[0].0,
                    if topic.is_some() { 2 } else { 51 },
                    topic.is_some(),
                    topic.map(|t| format!("'{t}'")).unwrap_or("NULL".into())
                )
            } else {
                format!("EXPLAIN (ANALYZE, BUFFERS) {sql}")
            };
            let lines: Vec<String> = if persistent {
                sqlx::query_scalar(&explain)
                    .fetch_all(&mut *connection)
                    .await
                    .unwrap()
            } else {
                page(&mut connection, &explain, false, topic, member, channel)
                    .await
                    .iter()
                    .map(|row| row.get(0))
                    .collect()
            };
            eprintln!("EXPLAIN {label} {variant}\n{}", lines.join("\n"));
            sqlx::raw_sql("ROLLBACK")
                .execute(&mut *connection)
                .await
                .unwrap();
        }
    }
}
