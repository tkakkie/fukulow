use super::super::reclamation::{batch, run_with_interval};
use super::*;
use std::time::Duration;

async fn old_rows(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM dm_discovery WHERE organization_id=$1 AND member_id=$2 AND membership_revision=0")
        .bind(f.org).bind(f.b).fetch_one(&f.pools.admin).await.unwrap()
}

async fn wait_reclaimed(f: &Fixture) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while old_rows(f).await != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[fukulow_test::test]
async fn maintenance_enumerator_is_bounded_restricted_and_does_not_bypass_tenant_rls(pool: PgPool) {
    use auth::members::next_maintenance_organization as next;
    let pools = TestPools::new(pool).await;
    assert_eq!(next(&pools.app, None).await.unwrap(), None);
    let mut orgs = [
        organization(&pools.admin).await,
        organization(&pools.admin).await,
    ];
    orgs.sort();
    assert_eq!(next(&pools.app, None).await.unwrap(), Some(orgs[0]));
    assert_eq!(
        next(&pools.app, Some(orgs[0])).await.unwrap(),
        Some(orgs[1])
    );
    assert_eq!(
        next(&pools.app, Some(orgs[1])).await.unwrap(),
        Some(orgs[0])
    );
    let visible: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations")
        .fetch_one(&pools.app)
        .await
        .unwrap();
    assert_eq!(visible, 0);
    let public_execute: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a WHERE p.oid='public.fukulow_next_maintenance_organization(uuid)'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE')")
        .fetch_one(&pools.admin).await.unwrap();
    assert!(!public_execute);
    let settings: Vec<String> = sqlx::query_scalar("SELECT proconfig FROM pg_proc WHERE oid='public.fukulow_next_maintenance_organization(uuid)'::regprocedure")
        .fetch_one(&pools.admin).await.unwrap();
    assert_eq!(settings, vec!["search_path=pg_catalog, pg_temp"]);
    // Even the global id lookup must not leave an unbounded backend waiting on DDL.
    let mut holder = pools.admin.begin().await.unwrap();
    sqlx::query("LOCK TABLE organizations IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *holder)
        .await
        .unwrap();
    let error = tokio::time::timeout(Duration::from_secs(3), next(&pools.app, None))
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("57014")
    );
    holder.rollback().await.unwrap();
    assert_eq!(next(&pools.app, None).await.unwrap(), Some(orgs[0]));
    pools.app.close().await;
}

#[fukulow_test::test]
async fn locked_old_counter_is_skipped_and_failed_delete_rolls_back_for_retry(pool: PgPool) {
    let f = Fixture::new(pool, "guest").await;
    f.dm().await;
    f.deactivate(f.b).await;
    let mut holder = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT position FROM dm_discovery_counters WHERE organization_id=$1 AND member_id=$2 FOR UPDATE")
        .bind(f.org).bind(f.b).execute(&mut *holder).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_millis(500), batch(&f.pools.app, f.org))
            .await
            .unwrap()
            .unwrap(),
        (0, 0)
    );
    holder.rollback().await.unwrap();
    sqlx::raw_sql("CREATE FUNCTION reject_reclaim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test reclamation error'; END $$; CREATE TRIGGER reject_reclaim BEFORE DELETE ON dm_discovery_counters FOR EACH ROW EXECUTE FUNCTION reject_reclaim();")
        .execute(&f.pools.admin).await.unwrap();
    assert!(batch(&f.pools.app, f.org).await.is_err());
    assert_eq!(
        old_rows(&f).await,
        1,
        "index deletion must roll back with counter deletion"
    );
    sqlx::query("DROP TRIGGER reject_reclaim ON dm_discovery_counters")
        .execute(&f.pools.admin)
        .await
        .unwrap();
    assert_eq!(batch(&f.pools.app, f.org).await.unwrap(), (1, 1));
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn periodic_reclamation_needs_no_traffic_survives_errors_and_stops_on_shutdown(pool: PgPool) {
    let mut a = Fixture::new(pool.clone(), "guest").await;
    let mut b = Fixture::new(pool, "guest").await;
    if a.org > b.org {
        std::mem::swap(&mut a, &mut b);
    }
    for f in [&a, &b] {
        f.dm().await;
        f.deactivate(f.b).await;
    }
    // Break one Organization; the other must still be visited on the next tick.
    let ddl = format!(
        "CREATE FUNCTION reject_one_reclaim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.organization_id='{}'::uuid THEN RAISE EXCEPTION 'test reclamation error'; END IF; RETURN OLD; END $$; CREATE TRIGGER reject_one_reclaim BEFORE DELETE ON dm_discovery FOR EACH ROW EXECUTE FUNCTION reject_one_reclaim();",
        a.org
    );
    sqlx::raw_sql(&ddl).execute(&a.pools.admin).await.unwrap();
    let shutdown = crate::shutdown::Shutdown::default();
    let task = tokio::spawn(run_with_interval(
        a.pools.app.clone(),
        shutdown.clone(),
        Duration::from_millis(200),
    ));
    wait_reclaimed(&b).await;
    assert_eq!(old_rows(&a).await, 1);
    assert!(!task.is_finished());
    sqlx::query("DROP TRIGGER reject_one_reclaim ON dm_discovery")
        .execute(&a.pools.admin)
        .await
        .unwrap();
    wait_reclaimed(&a).await;
    shutdown.begin();
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    // An already-cancelled worker never runs even the immediately ready first tick.
    b.reactivate(b.b).await;
    assert_eq!(b.open(&b.at, b.b, true).await.status(), StatusCode::OK);
    b.deactivate(b.b).await;
    run_with_interval(b.pools.app.clone(), shutdown, Duration::from_millis(1)).await;
    let remaining: i64 = sqlx::query_scalar("SELECT count(*) FROM dm_discovery WHERE organization_id=$1 AND member_id=$2 AND membership_revision=1")
        .bind(b.org).bind(b.b).fetch_one(&b.pools.admin).await.unwrap();
    assert_eq!(remaining, 1);
    a.pools.app.close().await;
}

#[fukulow_test::test]
async fn periodic_reclamation_runs_only_one_bounded_batch_per_tick(pool: PgPool) {
    let f = Fixture::new(pool, "guest").await;
    paging::large_fixture(&f, 1_001).await;
    f.deactivate(f.a).await;
    let shutdown = crate::shutdown::Shutdown::default();
    let task = tokio::spawn(run_with_interval(
        f.pools.app.clone(),
        shutdown.clone(),
        Duration::from_secs(60),
    ));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let remaining: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM dm_discovery WHERE organization_id=$1 AND member_id=$2",
            )
            .bind(f.org)
            .bind(f.a)
            .fetch_one(&f.pools.admin)
            .await
            .unwrap();
            if remaining < 1_001 {
                assert_eq!(remaining, 1);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!task.is_finished());
    shutdown.begin();
    tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(batch(&f.pools.app, f.org).await.unwrap(), (1, 1));
    f.pools.app.close().await;
}
