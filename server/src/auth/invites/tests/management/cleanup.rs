use super::*;
use crate::auth::invites::cleanup::{
    BATCH_SIZE, BATCH_SQL, batch, delete_batch, lock_batch, run_with_interval,
};
use crate::observability::tests::Capture;
use tracing::instrument::WithSubscriber;

async fn age(pool: &sqlx::PgPool, org: Uuid, ids: &[Uuid], column: &str) {
    sqlx::query(&format!(
        "UPDATE invites SET {column}=now()-interval '31 days' WHERE organization_id=$1 AND id=ANY($2)"
    ))
    .bind(org)
    .bind(ids)
    .execute(pool)
    .await
    .unwrap();
}

async fn tombstones(pool: &sqlx::PgPool, org: Uuid) -> Vec<Value> {
    sqlx::query_scalar(
        "SELECT to_jsonb(t) FROM invite_tombstones t WHERE organization_id=$1 ORDER BY id",
    )
    .bind(org)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[fukulow_test::test]
async fn cleanup_retains_each_lifecycle_for_30_days_and_is_organization_scoped(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, issuer, _, _) = account(&pool, org, Role::Owner).await;
    let (_, other_issuer, _, _) = account(&pool, other, Role::Owner).await;
    let foreign = seed(&pool, other, other_issuer, 1, false).await;
    age(&pool, other, &foreign, "expires_at").await;
    let rows = seed(&pool, org, issuer, 10, true).await;
    // (Expiry age, acceptance age, revocation age). Include both orders
    // for revoked/expired and a recent acceptance of a long-expired Invite.
    let cases = [
        (-7, None, None),
        (29, None, None),
        (31, None, None),
        (45, Some(29), None),
        (45, Some(31), None),
        (-7, None, Some(29)),
        (-7, None, Some(31)),
        (31, None, Some(29)),
        (29, None, Some(31)),
        (29, None, Some(29)),
    ];
    let mut removed = vec![];
    let mut kept = vec![];
    for (index, (id, (expiry, accepted, revoked))) in rows.into_iter().zip(cases).enumerate() {
        sqlx::query("UPDATE invites SET expires_at=now()-$3::int*interval '1 day', \
                     accepted_at=now()-$4::int*interval '1 day', revoked_at=now()-$5::int*interval '1 day' \
                     WHERE organization_id=$1 AND id=$2")
            .bind(org).bind(id).bind(expiry).bind(accepted).bind(revoked).execute(&pool).await.unwrap();
        if [2, 4, 6, 7, 8].contains(&index) {
            removed.push(id);
        } else {
            kept.push(id);
        }
    }
    kept.sort();
    let expected: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(i)-ARRAY['created_by','email','token_hash','expires_at','accepted_at','revoked_at'] \
         FROM invites i WHERE organization_id=$1 AND id=ANY($2) ORDER BY id",
    )
    .bind(org)
    .bind(&removed)
    .fetch_all(&pool)
    .await
    .unwrap();
    let state = AppState::for_test(pool.clone()).await;
    assert_eq!(batch(&state.pool, org).await.unwrap(), 5);
    for (scope, expected) in [(org, kept), (other, foreign)] {
        let remaining: Vec<Uuid> =
            sqlx::query_scalar("SELECT id FROM invites WHERE organization_id=$1 ORDER BY id")
                .bind(scope)
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining, expected);
    }
    assert!(tombstones(&pool, other).await.is_empty());
    assert_eq!(batch(&state.pool, org).await.unwrap(), 0);
    assert_eq!(tombstones(&pool, org).await, expected);
}

#[fukulow_test::test]
async fn cleanup_batch_is_bounded_and_resumes_remaining_work(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, issuer, _, _) = account(&pool, org, Role::Owner).await;
    let ids = seed(&pool, org, issuer, BATCH_SIZE as i32 + 1, false).await;
    age(&pool, org, &ids, "expires_at").await;
    let state = AppState::for_test(pool.clone()).await;
    assert_eq!(batch(&state.pool, org).await.unwrap(), BATCH_SIZE as u64);
    assert_eq!(tombstones(&pool, org).await.len(), BATCH_SIZE as usize);
    assert_eq!(batch(&state.pool, org).await.unwrap(), 1);
    assert_eq!(tombstones(&pool, org).await.len(), ids.len());
}

#[fukulow_test::test]
async fn cleanup_deletes_invite_with_preexisting_tombstone(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, issuer, _, _) = account(&pool, org, Role::Owner).await;
    let mut ids = seed(&pool, org, issuer, 2, false).await;
    ids.sort();
    age(&pool, org, &ids, "expires_at").await;
    sqlx::query(
        "INSERT INTO invite_tombstones (organization_id,id,created_at,role,owner_cursor,admin_cursor) \
         SELECT organization_id,id,created_at,role,owner_cursor,admin_cursor FROM invites \
         WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(ids[0])
    .execute(&pool)
    .await
    .unwrap();
    let existing = tombstones(&pool, org).await;

    let state = AppState::for_test(pool.clone()).await;
    assert_eq!(batch(&state.pool, org).await.unwrap(), 2);
    assert_eq!(batch(&state.pool, org).await.unwrap(), 0);
    let saved = tombstones(&pool, org).await;
    assert_eq!(saved.len(), 2);
    assert_eq!(saved[0], existing[0]);
    assert_eq!(saved[1]["id"], json!(ids[1]));
}

#[fukulow_test::test]
async fn cleanup_plan_uses_indexed_retention_cutoffs_under_rls(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, issuer, _, _) = account(&pool, org, Role::Owner).await;
    sqlx::query("INSERT INTO invites (organization_id,id,created_by,email,role,token_hash,expires_at,accepted_at,revoked_at) \
        SELECT $1,gen_random_uuid(),$2,'retained@example.invalid','member',sha256(gen_random_uuid()::text::bytea), \
        now()-interval '1 day', CASE WHEN n%3=1 THEN now()-interval '2 days' END, \
        CASE WHEN n%3=2 THEN now()-interval '2 days' END FROM generate_series(1,12000) n")
        .bind(org).bind(issuer).execute(&pool).await.unwrap();
    sqlx::query("VACUUM ANALYZE invites")
        .execute(&pool)
        .await
        .unwrap();
    let state = AppState::for_test(pool.clone()).await;
    for mode in ["force_custom_plan", "force_generic_plan"] {
        let mut tx = state.pool.begin().await.unwrap();
        crate::database::set_organization(&mut tx, org)
            .await
            .unwrap();
        sqlx::query("SELECT set_config('plan_cache_mode',$1,true)")
            .bind(mode)
            .execute(&mut *tx)
            .await
            .unwrap();
        lock_batch(&mut tx, org).await.unwrap();
        let plan =
            sqlx::query_scalar::<_, String>(&format!("EXPLAIN (ANALYZE,BUFFERS) {BATCH_SQL}"))
                .bind(org)
                .bind(BATCH_SIZE)
                .fetch_all(&mut *tx)
                .await
                .unwrap()
                .join("\n");
        tx.rollback().await.unwrap();
        assert!(!plan.contains("Seq Scan on invites"), "{mode}: {plan}");
        for (index, clock) in [
            ("accepted", "accepted_at"),
            ("expired", "expires_at"),
            ("revoked", "revoked_at"),
        ] {
            assert!(
                plan.contains(&format!("using invites_cleanup_{index}")),
                "{mode}: {plan}"
            );
            assert!(
                plan.lines()
                    .any(|line| line.contains("Index Cond:")
                        && line.contains(&format!("{clock} <="))),
                "{mode}: {plan}"
            );
        }
    }
}

#[fukulow_test::test]
async fn cleanup_racing_acceptance_keeps_member_changes_atomic(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let (recipient, _, email, token) = account(&pool, other, Role::Member).await;
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    let url = format!("{}/accept", path(org));
    let membership = || {
        sqlx::query_scalar::<_, Value>(
            "SELECT to_jsonb(u) FROM users u WHERE organization_id=$1 AND account_id=$2",
        )
        .bind(org)
        .bind(recipient)
        .fetch_optional(&pool)
    };
    let start_acceptance = |invite: &Value| {
        let (app, url, token) = (app.clone(), url.clone(), token.clone());
        let input = accept_input(invite, &email);
        tokio::spawn(async move { req(&app, "POST", &url, Some(&token), input).await })
    };

    let expired = invite(&app, org, &owner, &email, Role::Member).await;
    let mut cleanup = state.pool.begin().await.unwrap();
    crate::database::set_organization(&mut cleanup, org)
        .await
        .unwrap();
    lock_batch(&mut cleanup, org).await.unwrap();
    let accept = start_acceptance(&expired);
    waiting(
        &pool,
        "SELECT organization_id FROM organizations%FOR NO KEY UPDATE",
    )
    .await;
    // Model the expiry and retention clocks advancing after acceptance's preflight.
    sqlx::query(
        "UPDATE invites SET expires_at=now()-interval '31 days' WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(id(&expired))
    .execute(&mut *cleanup)
    .await
    .unwrap();
    assert_eq!(delete_batch(&mut cleanup, org).await.unwrap(), 1);
    cleanup.commit().await.unwrap();
    let r = accept.await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(r).await, json!({"error":"invite_unavailable"}));
    assert!(membership().await.unwrap().is_none());

    let accepted = invite(&app, org, &owner, &email, Role::Admin).await;
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM invites WHERE organization_id=$1 AND id=$2 FOR UPDATE")
        .bind(org)
        .bind(id(&accepted))
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    let accept = start_acceptance(&accepted);
    waiting(
        &pool,
        "SELECT email,role,created_by FROM invites%FOR UPDATE",
    )
    .await;
    let cleanup = tokio::spawn({
        let pool = state.pool.clone();
        async move { batch(&pool, org).await }
    });
    waiting(
        &pool,
        "SELECT organization_id FROM organizations%FOR NO KEY UPDATE",
    )
    .await;
    blocker.commit().await.unwrap();
    assert_eq!(accept.await.unwrap().status(), StatusCode::OK);
    assert_eq!(cleanup.await.unwrap().unwrap(), 0);
    let member = membership().await.unwrap().unwrap();
    assert_eq!(member["role"], "admin");
    age(&pool, org, &[id(&accepted)], "accepted_at").await;
    assert_eq!(batch(&state.pool, org).await.unwrap(), 1);
    assert_eq!(membership().await.unwrap(), Some(member));
    let before = snapshot(&pool).await;
    denied(
        &pool,
        start_acceptance(&accepted).await.unwrap(),
        &before,
        StatusCode::NOT_FOUND,
        "invite_unavailable",
    )
    .await;
}

#[fukulow_test::test]
async fn cleanup_preserves_owner_and_admin_pages_through_expired_and_revoked_anchors(
    pool: sqlx::PgPool,
) {
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    for role in [Role::Owner, Role::Admin] {
        for column in ["expires_at", "revoked_at"] {
            let org = org(&pool).await;
            let (_, issuer, _, _) = account(&pool, org, Role::Owner).await;
            let (_, _, _, token) = account(&pool, org, role).await;
            let mut ids = seed(&pool, org, issuer, 250, false).await;
            ids.sort();
            let first = page(&app, org, &token, None).await;
            assert_eq!(id(&first["invites"][99]), ids[99]);
            age(&pool, org, &[ids[5], ids[99], ids[155]], column).await;
            assert_eq!(batch(&state.pool, org).await.unwrap(), 3);

            let second = page(&app, org, &token, first["next_cursor"].as_str()).await;
            let third = page(&app, org, &token, second["next_cursor"].as_str()).await;
            let seen = second["invites"]
                .as_array()
                .unwrap()
                .iter()
                .chain(third["invites"].as_array().unwrap())
                .map(id)
                .collect::<Vec<_>>();
            assert_eq!(
                seen,
                ids[100..]
                    .iter()
                    .copied()
                    .filter(|id| *id != ids[155])
                    .collect::<Vec<_>>()
            );
            assert!(third.get("next_cursor").is_none());
        }
    }
}

#[fukulow_test::test]
async fn tombstone_cursors_keep_uniform_organization_and_role_denials(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    let (_, _, _, foreign_owner) = account(&pool, other, Role::Owner).await;
    let (_, _, _, foreign_admin) = account(&pool, other, Role::Admin).await;
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    seed(&pool, org, issuer, 101, false).await;
    let owner_page = page(&app, org, &owner, None).await;
    let admin_page = page(&app, org, &admin, None).await;
    let anchor = id(&admin_page["invites"][99]);
    age(&pool, org, &[anchor], "revoked_at").await;
    assert_eq!(batch(&state.pool, org).await.unwrap(), 1);

    let owner_cursor = owner_page["next_cursor"].as_str().unwrap();
    let admin_cursor = admin_page["next_cursor"].as_str().unwrap();
    let before = snapshot(&pool).await;
    let unknown = Uuid::new_v4().to_string();
    for (scope, token, cursor) in [
        (org, &owner, admin_cursor),
        (org, &admin, owner_cursor),
        (other, &foreign_owner, owner_cursor),
        (other, &foreign_admin, admin_cursor),
        (org, &owner, &unknown),
    ] {
        let r = req(
            &app,
            "GET",
            &format!("{}?cursor={cursor}", path(scope)),
            Some(token),
            Value::Null,
        )
        .await;
        denied(&pool, r, &before, StatusCode::BAD_REQUEST, "invalid input").await;
    }
    // The tombstone still enforces the Owner-Role filter on an Admin-column match.
    sqlx::query("UPDATE invite_tombstones SET role='owner' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(anchor)
        .execute(&pool)
        .await
        .unwrap();
    let before = snapshot(&pool).await;
    let r = req(
        &app,
        "GET",
        &format!("{}?cursor={admin_cursor}", path(org)),
        Some(&admin),
        Value::Null,
    )
    .await;
    denied(&pool, r, &before, StatusCode::BAD_REQUEST, "invalid input").await;
    let r = req(
        &app,
        "DELETE",
        &format!("{}/{anchor}", path(org)),
        Some(&owner),
        Value::Null,
    )
    .await;
    denied(
        &pool,
        r,
        &before,
        StatusCode::NOT_FOUND,
        "invite_unavailable",
    )
    .await;
}

#[fukulow_test::test]
async fn failed_cleanup_rolls_back_logs_and_retries_without_blocking_invite_writes(
    pool: sqlx::PgPool,
) {
    let mut scopes = [org(&pool).await, org(&pool).await];
    scopes.sort();
    let [org, other] = scopes;
    let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, other_issuer, email, token) = account(&pool, other, Role::Owner).await;
    let doomed = seed(&pool, org, issuer, 1, false).await;
    let healthy = seed(&pool, other, other_issuer, 1, false).await;
    age(&pool, org, &doomed, "expires_at").await;
    age(&pool, other, &healthy, "expires_at").await;
    sqlx::raw_sql(&format!(
        "CREATE FUNCTION reject_invite_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN IF OLD.organization_id='{org}' THEN RAISE EXCEPTION 'fixture cleanup error'; END IF; RETURN OLD; END $$; \
         CREATE TRIGGER fail_cleanup AFTER DELETE ON invites FOR EACH ROW EXECUTE FUNCTION reject_invite_cleanup();"
    )).execute(&pool).await.unwrap();
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    let output = Capture::default();
    let (stop, cancelled) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(
        run_with_interval(
            state.pool,
            async {
                let _ = cancelled.await;
            },
            Duration::from_secs(1),
        )
        .with_subscriber(output.subscriber()),
    );
    let wait_for_tombstone = async |scope| {
        tokio::time::timeout(Duration::from_secs(10), async {
            while tombstones(&pool, scope).await.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    };
    wait_for_tombstone(other).await;
    assert!(tombstones(&pool, org).await.is_empty());
    assert!(output.events().iter().any(|event| {
        let fields = &event["fields"];
        fields["event"] == "database_failure"
            && fields["operation"] == "invite_cleanup_batch"
            && fields["organization_id"] == org.to_string()
            && !event.to_string().contains("fixture cleanup error")
    }));
    let present: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM invites WHERE organization_id=$1 AND id=$2)",
    )
    .bind(org)
    .bind(doomed[0])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(present);
    let i = invite(&app, org, &owner, &email, Role::Member).await;
    let response = req(
        &app,
        "POST",
        &format!("{}/accept", path(org)),
        Some(&token),
        accept_input(&i, &email),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    sqlx::query("DROP TRIGGER fail_cleanup ON invites")
        .execute(&pool)
        .await
        .unwrap();
    wait_for_tombstone(org).await;
    assert_eq!(id(&tombstones(&pool, org).await[0]), doomed[0]);
    stop.send(()).unwrap();
    task.await.unwrap();
}
