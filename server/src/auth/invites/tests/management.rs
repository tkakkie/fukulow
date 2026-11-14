use super::super::management::{ListInvitesQuery, list_invites, revoke_invite};
use super::*;
use axum::extract::Query;
use std::time::Duration;

async fn snapshot(pool: &sqlx::PgPool) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_array( \
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM accounts a), \
        (SELECT jsonb_agg(to_jsonb(u) ORDER BY organization_id,id) FROM users u), \
        (SELECT jsonb_agg(to_jsonb(i) ORDER BY organization_id,id) FROM invites i), \
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY token_hash) FROM account_sessions s))",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn denied(
    pool: &sqlx::PgPool,
    response: Response,
    before: &Value,
    status: StatusCode,
    error: &str,
) {
    assert_eq!(response.status(), status);
    let value = body(response).await;
    assert_eq!(value, json!({"error":error}));
    assert!(!value.to_string().contains('@'));
    assert_eq!(&snapshot(pool).await, before);
}

fn path(org: Uuid) -> String {
    format!("/api/v1/orgs/{org}/invites")
}
fn id(i: &Value) -> Uuid {
    i["id"].as_str().unwrap().parse().unwrap()
}

async fn page(app: &Router, org: Uuid, token: &str, cursor: Option<&str>) -> Value {
    let url = match cursor {
        Some(c) => format!("{}?cursor={c}", path(org)),
        None => path(org),
    };
    let r = req(app, "GET", &url, Some(token), Value::Null).await;
    assert_eq!(r.status(), StatusCode::OK);
    let value = body(r).await;
    assert!(!value.to_string().contains("token"));
    value
}

async fn seed(pool: &sqlx::PgPool, org: Uuid, issuer: Uuid, count: i32, owner: bool) -> Vec<Uuid> {
    // Equal timestamps exercise the id tie-breaker, independent of insertion order.
    sqlx::query_scalar(
        "INSERT INTO invites (organization_id,id,created_by,email,role,token_hash,created_at) \
        SELECT $1,gen_random_uuid(),$2,'invite-'||n||'@example.invalid', \
        CASE WHEN $4 AND n%2=0 THEN 'owner' ELSE 'member' END, \
        sha256(convert_to(gen_random_uuid()::text,'UTF8')), '2026-01-01'::timestamptz \
        FROM generate_series(1,$3) n RETURNING id",
    )
    .bind(org)
    .bind(issuer)
    .bind(count)
    .bind(owner)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn waiting(pool: &sqlx::PgPool, pattern: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1)")
                .bind(pattern).fetch_one(pool).await.unwrap();
            if exists { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
}

mod concurrency;
mod denials;
mod paging;
