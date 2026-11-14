use super::super::reclamation::{BATCH_SIZE, batch, reclaim};
use super::*;
use std::time::Duration;

async fn feed(pool: &PgPool, org: Uuid) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(d) ORDER BY member_id,membership_revision,channel_id) FROM dm_discovery d WHERE organization_id=$1),(SELECT jsonb_agg(to_jsonb(c) ORDER BY member_id,membership_revision) FROM dm_discovery_counters c WHERE organization_id=$1))")
        .bind(org).fetch_one(pool).await.unwrap()
}

async fn count(pool: &PgPool, org: Uuid, member: Uuid, revision: i64) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM dm_discovery WHERE organization_id=$1 AND member_id=$2 AND membership_revision=$3")
        .bind(org).bind(member).bind(revision).fetch_one(pool).await.unwrap()
}

async fn copy_revision(f: &Fixture, revision: i64) {
    sqlx::query("INSERT INTO dm_discovery_counters SELECT organization_id,member_id,$3,position FROM dm_discovery_counters WHERE organization_id=$1 AND member_id=$2 AND membership_revision=0")
        .bind(f.org).bind(f.a).bind(revision).execute(&f.pools.admin).await.unwrap();
    sqlx::query("INSERT INTO dm_discovery SELECT organization_id,member_id,$3,channel_id,grant_id,birth_position,latest_position FROM dm_discovery WHERE organization_id=$1 AND member_id=$2 AND membership_revision=0")
        .bind(f.org).bind(f.a).bind(revision).execute(&f.pools.admin).await.unwrap();
}

#[fukulow_test::test]
async fn reclaims_only_strictly_older_revisions_and_preserves_other_organizations(pool: PgPool) {
    let f = Fixture::new(pool, "guest").await;
    let c = f.dm().await;
    let guest = f.get(&f.bt, "/api/v1/dms/changes?lane=coverage").await;
    // Equal and future revisions must survive even without a usable grant.
    copy_revision(&f, 1).await;
    copy_revision(&f, 2).await;
    let foreign = organization(&f.pools.admin).await;
    let at = member(&f.pools.admin, foreign, f.a, "member").await;
    member(&f.pools.admin, foreign, f.b, "guest").await;
    assert_eq!(f.open(&at, f.b, false).await.status(), StatusCode::CREATED);
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(foreign)
        .bind(f.a)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    let foreign_before = feed(&f.pools.admin, foreign).await;
    let before = feed(&f.pools.admin, f.org).await;
    assert_eq!(batch(&f.pools.app, f.org).await.unwrap(), (0, 0));
    assert_eq!(batch(&f.pools.admin, f.org).await.unwrap(), (0, 0));
    assert_eq!(feed(&f.pools.admin, f.org).await, before);
    // A deactivation that has not committed cannot invalidate any feed.
    let mut pending = f.pools.admin.begin().await.unwrap();
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(f.a)
        .execute(&mut *pending)
        .await
        .unwrap();
    assert_eq!(batch(&f.pools.app, f.org).await.unwrap(), (0, 0));
    assert_eq!(feed(&f.pools.admin, f.org).await, before);
    pending.commit().await.unwrap();
    // No renewal is needed before old rows become reclaimable.
    assert_eq!(batch(&f.pools.app, f.org).await.unwrap(), (1, 1));
    for revision in [1, 2] {
        assert_eq!(count(&f.pools.admin, f.org, f.a, revision).await, 1);
    }
    assert_eq!(count(&f.pools.admin, f.org, f.b, 0).await, 1);
    assert_eq!(feed(&f.pools.admin, foreign).await, foreign_before);
    let after = feed(&f.pools.admin, f.org).await;
    assert_eq!(batch(&f.pools.app, f.org).await.unwrap(), (0, 0));
    assert_eq!(feed(&f.pools.admin, f.org).await, after);
    // Peer loss does not invalidate the Guest's own feed or its saved cursor.
    let page = f
        .get(
            &f.bt,
            &format!(
                "/api/v1/dms/changes?lane=coverage&cursor={}",
                guest["next_cursor"].as_str().unwrap()
            ),
        )
        .await;
    assert_eq!(page["dms"][0]["id"], c.to_string());
    assert_eq!(batch(&f.pools.app, foreign).await.unwrap(), (1, 1));
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn reclamation_bounds_rows_keeps_nonempty_counter_and_reruns_idempotently(pool: PgPool) {
    let f = Fixture::new(pool, "guest").await;
    paging::large_fixture(&f, BATCH_SIZE as usize + 1).await;
    f.deactivate(f.a).await;
    assert_eq!(
        batch(&f.pools.app, f.org).await.unwrap(),
        (BATCH_SIZE as u64, 0)
    );
    assert_eq!(count(&f.pools.admin, f.org, f.a, 0).await, 1);
    let position: i64 = sqlx::query_scalar("SELECT position FROM dm_discovery_counters WHERE organization_id=$1 AND member_id=$2 AND membership_revision=0")
        .bind(f.org).bind(f.a).fetch_one(&f.pools.admin).await.unwrap();
    assert_eq!(position, BATCH_SIZE + 1);
    assert_eq!(batch(&f.pools.app, f.org).await.unwrap(), (1, 1));
    assert_eq!(count(&f.pools.admin, f.org, f.a, 0).await, 0);
    let after = feed(&f.pools.admin, f.org).await;
    assert_eq!(batch(&f.pools.app, f.org).await.unwrap(), (0, 0));
    assert_eq!(feed(&f.pools.admin, f.org).await, after);
    // All current peer rows/counters survive both batches.
    assert_eq!(after[0].as_array().unwrap().len(), BATCH_SIZE as usize + 1);
    assert_eq!(after[1].as_array().unwrap().len(), BATCH_SIZE as usize + 1);
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn reclaimed_revision_cursors_fail_and_older_read_snapshots_stay_complete(pool: PgPool) {
    let f = Fixture::new(pool, "guest").await;
    paging::large_fixture(&f, 51).await;
    let captured = extract_auth(f.state.clone(), &f.at).await;
    let mut paths = Vec::new();
    for lane in ["delta", "coverage"] {
        let page = f
            .get(&f.at, &format!("/api/v1/dms/changes?lane={lane}"))
            .await;
        let path = format!(
            "/api/v1/dms/changes?lane={lane}&cursor={}",
            page["next_cursor"].as_str().unwrap()
        );
        assert_eq!(
            f.get(&f.at, &path).await["dms"].as_array().unwrap().len(),
            1
        );
        paths.push(path);
    }
    let mut snapshot = f.pools.app.begin().await.unwrap();
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *snapshot)
        .await
        .unwrap();
    crate::database::set_organization(&mut snapshot, f.org)
        .await
        .unwrap();
    auth::members::require_current(&mut snapshot, &captured)
        .await
        .unwrap();
    f.deactivate(f.a).await;
    assert_eq!(batch(&f.pools.app, f.org).await.unwrap(), (51, 1));
    for lane in ["delta", "coverage"] {
        let page = discovery::page(
            &mut snapshot,
            &captured,
            &f.state.setup_token,
            lane,
            Cursor::default(),
        )
        .await
        .unwrap();
        assert_eq!(page.dms.len(), 50);
        let cursor =
            Cursor::decode(&page.next_cursor, &f.state.setup_token, &captured, lane).unwrap();
        let last = discovery::page(&mut snapshot, &captured, &f.state.setup_token, lane, cursor)
            .await
            .unwrap();
        assert_eq!(last.dms.len(), 1);
        assert!(last.caught_up);
    }
    snapshot.rollback().await.unwrap();
    for path in &paths {
        let denied = request(&f.app, "GET", path, &f.at, Value::Null).await;
        assert_eq!(denied.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(denied).await,
            json!({"error":"organization_unavailable"})
        );
    }
    f.reactivate(f.a).await;
    for path in &paths {
        let denied = request(&f.app, "GET", path, &f.at, Value::Null).await;
        assert_eq!(denied.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body(denied).await, json!({"error":"invalid input"}));
    }
    let stale = crate::database::organization_read_only(
        &f.pools.app,
        f.org,
        async |tx: &mut PgConnection| auth::members::require_current(tx, &captured).await,
    )
    .await;
    assert_eq!(stale.err().unwrap().1, "organization_unavailable");
    assert_eq!(
        f.get(&f.at, "/api/v1/dms/changes?lane=delta").await["dms"],
        json!([])
    );
    f.pools.app.close().await;
}

#[fukulow_test::test]
async fn reclamation_and_open_renew_send_complete_in_both_lock_orders(pool: PgPool) {
    let f = Fixture::new(pool, "member").await;
    let c = f.dm().await;
    f.deactivate(f.b).await;
    f.reactivate(f.b).await;
    // Cleanup first: retain its real locks while open, renewal and sends commit.
    let mut cleanup = f.pools.app.begin().await.unwrap();
    crate::database::set_organization(&mut cleanup, f.org)
        .await
        .unwrap();
    assert_eq!(reclaim(&mut cleanup, f.org).await.unwrap(), (1, 1));
    let peer = Uuid::new_v4();
    member(&f.pools.admin, f.org, peer, "guest").await;
    tokio::time::timeout(Duration::from_secs(1), async {
        assert_eq!(f.open(&f.at, f.b, true).await.status(), StatusCode::OK);
        assert_eq!(
            f.open(&f.at, peer, false).await.status(),
            StatusCode::CREATED
        );
        let (a, b) = tokio::join!(
            f.send(&f.at, c, Uuid::new_v4()),
            f.send(&f.bt, c, Uuid::new_v4())
        );
        assert_eq!(a.status(), StatusCode::CREATED);
        assert_eq!(b.status(), StatusCode::CREATED);
    })
    .await
    .unwrap();
    cleanup.commit().await.unwrap();
    // Renewal first: its current counters/grants stay locked during cleanup.
    f.deactivate(f.b).await;
    f.reactivate(f.b).await;
    let actor = extract_auth(f.state.clone(), &f.at).await;
    let mut renewal = f.pools.admin.begin().await.unwrap();
    open(
        &mut renewal,
        &actor,
        &OpenDmRequest {
            member_id: f.b,
            renew: true,
        },
        &activity::Activity::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), batch(&f.pools.app, f.org))
            .await
            .unwrap()
            .unwrap(),
        (1, 1)
    );
    renewal.commit().await.unwrap();
    // Send first: stop after its discovery write, before the COMMIT barrier.
    f.deactivate(f.b).await;
    f.reactivate(f.b).await;
    assert_eq!(f.open(&f.at, f.b, true).await.status(), StatusCode::OK);
    let mut barrier = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text || '/' || $2::uuid::text,135))")
        .bind(f.org).bind(c).execute(&mut *barrier).await.unwrap();
    let send = {
        let app = f.app.clone();
        let token = f.bt.clone();
        tokio::spawn(async move {
            request(
                &app,
                "POST",
                &format!("/api/v1/channels/{c}/messages"),
                &token,
                json!({"client_message_id":Uuid::new_v4(),"body":"concurrent"}),
            )
            .await
        })
    };
    concurrency::wait_lock(&f.pools.admin, "WITH timeout%135%").await;
    assert!(!send.is_finished());
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), batch(&f.pools.app, f.org))
            .await
            .unwrap()
            .unwrap(),
        (1, 1)
    );
    barrier.commit().await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), send)
            .await
            .unwrap()
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    let drift: i64 = sqlx::query_scalar("SELECT count(*) FROM dm_discovery d JOIN channel_members g USING(organization_id,channel_id,member_id) WHERE d.organization_id=$1 AND (d.membership_revision<>g.membership_revision OR d.grant_id<>g.grant_id)")
        .bind(f.org).fetch_one(&f.pools.admin).await.unwrap();
    assert_eq!(drift, 0);
    assert_eq!(count(&f.pools.admin, f.org, f.a, 0).await, 2);
    assert_eq!(count(&f.pools.admin, f.org, f.b, 3).await, 1);
    for token in [&f.at, &f.bt] {
        assert!(
            f.get(token, "/api/v1/dms/changes?lane=coverage").await["dms"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["id"] == c.to_string())
        );
    }
    f.pools.app.close().await;
}
