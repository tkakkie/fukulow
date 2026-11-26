use super::super::{channel, member};
use crate::messages::receipts::{self, Purge};
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

async fn organizations(pool: &PgPool, count: u128) -> Vec<Uuid> {
    let ids: Vec<_> = (1..=count).map(Uuid::from_u128).collect();
    sqlx::query(
        "INSERT INTO organizations (organization_id, name)
         SELECT id, 'Organization' FROM unnest($1::uuid[]) AS org(id)",
    )
    .bind(&ids)
    .execute(pool)
    .await
    .unwrap();
    ids
}

async fn seed(pool: &PgPool, org: Uuid, expired: i32, fresh: i32) {
    let actor = Uuid::new_v4();
    let channel_id = Uuid::new_v4();
    member(pool, org, actor).await;
    channel(pool, org, channel_id, actor, false).await;
    sqlx::query(
        "INSERT INTO operation_receipts (organization_id, actor, operation_id, kind, channel_id,
                                        target_id, intent_digest, outcome_version, outcome_deleted, created_at)
         SELECT $1, $2, gen_random_uuid(), 'edit', $3, gen_random_uuid(), sha256('x'::bytea), 1, false,
                CASE WHEN n <= $4 THEN now() - interval '8 days' ELSE now() END
         FROM generate_series(1, $4 + $5) AS n",
    )
    .bind(org)
    .bind(actor)
    .bind(channel_id)
    .bind(expired)
    .bind(fresh)
    .execute(pool)
    .await
    .unwrap();
}

async fn remaining(pool: &PgPool, org: Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM operation_receipts WHERE organization_id=$1")
        .bind(org)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn tick(purge: &mut Purge, pool: &PgPool) {
    // Drive the production scheduler without relying on wall-clock tick or query timing.
    purge
        .tick(pool, Duration::from_secs(30), Duration::from_secs(60))
        .await;
}

#[fukulow_test::test]
async fn purge_drains_busy_organization_among_idle_ones(pool: PgPool) {
    let org = *organizations(&pool, 97).await.last().unwrap();
    seed(&pool, org, 20_123, 0).await;
    let app = crate::test_app_pool(pool.clone()).await;
    let mut purge = Purge::default();
    // UUID order places the busy Organization behind 96 idle Organizations.
    for expected in [20_123, 20_123, 20_123, 10_123, 123, 0] {
        tick(&mut purge, &app).await;
        assert_eq!(remaining(&pool, org).await, expected);
    }
}

#[fukulow_test::test]
async fn purge_rotates_backlogged_organizations_across_ticks(pool: PgPool) {
    let orgs = organizations(&pool, 11).await;
    seed(&pool, orgs[0], 20_000, 0).await;
    for &org in &orgs[1..] {
        seed(&pool, org, 1_001, 0).await;
    }
    let app = crate::test_app_pool(pool.clone()).await;
    let mut purge = Purge::default();
    tick(&mut purge, &app).await;
    assert_eq!(remaining(&pool, orgs[0]).await, 19_000);
    for &org in &orgs[1..10] {
        assert_eq!(remaining(&pool, org).await, 1);
    }
    assert_eq!(remaining(&pool, orgs[10]).await, 1_001);

    tick(&mut purge, &app).await;
    assert_eq!(remaining(&pool, orgs[0]).await, 18_000);
    assert_eq!(remaining(&pool, orgs[10]).await, 1);
}

#[fukulow_test::test]
async fn purge_probe_and_batch_deny_foreign_and_unexpired_rows(pool: PgPool) {
    let orgs = organizations(&pool, 2).await;
    let (local, foreign) = (orgs[0], orgs[1]);
    seed(&pool, local, 0, 1).await;
    seed(&pool, foreign, 1, 0).await;
    let app = crate::test_app_pool(pool.clone()).await;

    assert!(!receipts::has_expired(&app, local).await.unwrap());
    assert_eq!(receipts::purge(&app, local).await.unwrap(), 0);
    assert_eq!(remaining(&pool, local).await, 1);
    assert_eq!(remaining(&pool, foreign).await, 1);
    assert!(receipts::has_expired(&app, foreign).await.unwrap());
    assert_eq!(receipts::purge(&app, foreign).await.unwrap(), 1);
    assert_eq!(remaining(&pool, local).await, 1);
}

#[fukulow_test::test]
async fn purge_skips_locked_receipt_until_next_sweep(pool: PgPool) {
    let org = organizations(&pool, 1).await[0];
    seed(&pool, org, 2, 0).await;
    let app = crate::test_app_pool(pool.clone()).await;
    let mut lock = pool.begin().await.unwrap();
    let locked: Uuid = sqlx::query_scalar(
        "SELECT operation_id FROM operation_receipts WHERE organization_id=$1
         ORDER BY created_at, actor, operation_id LIMIT 1 FOR UPDATE",
    )
    .bind(org)
    .fetch_one(&mut *lock)
    .await
    .unwrap();

    let mut purge = Purge::default();
    tick(&mut purge, &app).await;
    let survivors: Vec<Uuid> =
        sqlx::query_scalar("SELECT operation_id FROM operation_receipts WHERE organization_id=$1")
            .bind(org)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(survivors, [locked]);

    lock.rollback().await.unwrap();
    tick(&mut purge, &app).await;
    assert_eq!(remaining(&pool, org).await, 0);
}
