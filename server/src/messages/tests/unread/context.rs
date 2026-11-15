use super::*;
use crate::database::tests::context::clean;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

// The same Account, Member and Channel ids in both Organizations catch joins
// that accidentally rely on globally unique ids instead of Organization scope.
async fn tenants(pool: &PgPool) -> (String, Vec<(Uuid, Uuid, i64, i64)>) {
    let (member_id, channel_id) = (Uuid::new_v4(), Uuid::new_v4());
    let org_a = organization(pool).await;
    let token = member(pool, org_a, member_id).await;
    let org_b = organization(pool).await;
    sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) SELECT $1,id,account_id,name,role FROM users WHERE organization_id=$2 AND id=$3")
        .bind(org_b).bind(org_a).bind(member_id).execute(pool).await.unwrap();
    let mut tenants = Vec::new();
    for (index, org) in [org_a, org_b].into_iter().enumerate() {
        channel(pool, org, channel_id, member_id, true).await;
        if index == 0 {
            sqlx::query("UPDATE channel_members SET manager=true WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(org).bind(channel_id).bind(member_id).execute(pool).await.unwrap();
        }
        let sender = Uuid::new_v4();
        member(pool, org, sender).await;
        // Different other-sender main/Topic counts in each Organization.
        for _ in 0..=index {
            historical_post(pool, org, sender, channel_id, None).await;
        }
        for _ in 0..index + 2 {
            historical_post(pool, org, sender, channel_id, Some("Unread")).await;
        }
        tenants.push((org, channel_id, index as i64 + 1, index as i64 * 2 + 3));
    }
    (token, tenants)
}

async fn single(pool: &PgPool, mode: &'static str) -> PgPool {
    let app = crate::test_app_pool(pool.clone()).await;
    PgPoolOptions::new()
        .max_connections(1)
        .after_connect(move |connection, _| {
            Box::pin(async move {
                sqlx::query(&format!("SET plan_cache_mode={mode}"))
                    .execute(connection)
                    .await
                    .map(|_| ())
            })
        })
        .connect_with(app.connect_options().as_ref().clone())
        .await
        .unwrap()
}

fn list_router(pool: &PgPool) -> Router {
    Router::new()
        .route(
            "/api/v1/orgs/{org}/channels",
            axum::routing::get(list_channels),
        )
        .with_state(AppState::with_test_pool(pool.clone()))
}

async fn assert_list(app: &Router, token: &str, tenant: (Uuid, Uuid, i64, i64), manager: bool) {
    let (org, channel, main, total) = tenant;
    let response = request(
        app,
        "GET",
        &format!("/api/v1/orgs/{org}/channels"),
        token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let list = body(response).await;
    let entries = list["channels"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"], json!(channel));
    assert_eq!(entries[0]["as_of_seq"], total);
    assert_eq!(entries[0]["main_unread_count"], main);
    assert_eq!(entries[0]["unread_count"], total);
    assert_eq!(entries[0]["mention_unread_count"], 0);
    assert_eq!(
        entries[0]["capabilities"]["can_manage_managers"]["allowed"],
        manager
    );
}

#[fukulow_test::test]
async fn unread_same_account_switches_organizations_on_reused_connection_in_each_plan_mode(
    pool: PgPool,
) {
    let (token, tenants) = tenants(&pool).await;
    for mode in ["force_custom_plan", "force_generic_plan", "auto"] {
        let single = single(&pool, mode).await;
        let app = list_router(&single);
        let pid = clean(&single).await;
        for _ in 0..6 {
            for (index, tenant) in tenants.iter().enumerate() {
                assert_list(&app, &token, *tenant, index == 0).await;
                assert_eq!(clean(&single).await, pid, "{mode}: reused and clean");
                let absent: i64 = sqlx::query_scalar("SELECT count(*) FROM channels")
                    .fetch_one(&single)
                    .await
                    .unwrap();
                assert_eq!(absent, 0, "{mode}: unset context fails closed");
            }
        }
        single.close().await;
    }
}

#[fukulow_test::test]
async fn unread_cancelled_counts_discard_context_and_recover_in_each_plan_mode(pool: PgPool) {
    let (token, tenants) = tenants(&pool).await;
    for mode in ["force_custom_plan", "force_generic_plan", "auto"] {
        let single = single(&pool, mode).await;
        let app = list_router(&single);
        assert_list(&app, &token, tenants[0], true).await;
        let pid = clean(&single).await;
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE topics IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *blocker)
            .await
            .unwrap();
        let pending_app = app.clone();
        let pending_token = token.clone();
        let org = tenants[0].0;
        let pending = tokio::spawn(async move {
            request(
                &pending_app,
                "GET",
                &format!("/api/v1/orgs/{org}/channels"),
                &pending_token,
                Value::Null,
            )
            .await
        });
        // Observe the real count statement blocked inside PostgreSQL, after
        // authentication, local context setup and the visible-list read.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let waiting: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND query LIKE '%WITH unread_topics%')")
                    .bind(pid).fetch_one(&pool).await.unwrap();
                if waiting { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("count statement reached the lock wait");
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        blocker.rollback().await.unwrap();
        let replacement = tokio::time::timeout(Duration::from_secs(5), clean(&single))
            .await
            .unwrap();
        assert_ne!(replacement, pid, "{mode}: cancelled transaction discarded");
        assert_list(&app, &token, tenants[1], false).await;
        assert_eq!(clean(&single).await, replacement);
        assert_list(&app, &token, tenants[0], true).await;
        assert_eq!(clean(&single).await, replacement);
        single.close().await;
    }
}
