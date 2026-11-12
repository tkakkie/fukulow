use super::*;
use crate::auth::session::tests::{Phase, fixture};

mod exit;

#[sqlx::test]
async fn readiness_rejects_abnormal_worker_until_process_replacement(pool: PgPool) {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use tower::ServiceExt;

    async fn status(router: &axum::Router, expected: StatusCode) {
        let response = router
            .clone()
            .oneshot(Request::get("/api/v1/ready").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        if expected == StatusCode::OK {
            assert_eq!(body, "ok");
        } else {
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                serde_json::json!({"error": "not_ready"})
            );
        }
    }
    let changes = SessionChanges::with_recheck_timing(Duration::from_millis(20), CHECK_TIMEOUT)
        .with_on_fatal(Arc::new(|| {}));
    let mut state = crate::AppState::for_test(pool.clone());
    state.session_changes = changes.clone();
    let router = crate::app(state);
    status(&router, axum::http::StatusCode::OK).await;
    changes.start_rechecks(&pool);
    status(&router, axum::http::StatusCode::OK).await;
    changes.panic_worker().await;
    status(&router, axum::http::StatusCode::SERVICE_UNAVAILABLE).await;
    // The latch never resets in-process: #163 recovers by starting a fresh process.
    let replacement = crate::app(crate::AppState::for_test(pool));
    status(&replacement, axum::http::StatusCode::OK).await;
}
async fn active_checks(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() \
         AND state = 'active' AND query LIKE $1",
    )
    .bind("SELECT registered.organization_id, registered.token_hash%")
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn wait_for_check(pool: &PgPool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while active_checks(pool).await == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[sqlx::test]
async fn many_socket_monitors_share_one_non_overlapping_fallback_query(pool: PgPool) {
    let (mut state, auth) = fixture(&pool).await;
    let (_, foreign) = fixture(&pool).await;
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(50), Duration::from_secs(2));
    let key = (auth.identity.organization.organization_id, auth.token_hash);
    let foreign_key = (
        foreign.identity.organization.organization_id,
        foreign.token_hash,
    );
    // Same hash, different Organization: the valid foreign row must not mask this deletion.
    sqlx::query("DELETE FROM account_sessions WHERE token_hash = $1")
        .bind(&key.1)
        .execute(&pool)
        .await
        .unwrap();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE account_sessions IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *held)
        .await
        .unwrap();
    let sockets: Vec<_> = (0..128_u32)
        .map(|i| SessionWatch {
            registration: state.session_changes.register(if i < 64 {
                key.clone()
            } else {
                (key.0, i.to_be_bytes().to_vec())
            }),
            deadline: Some(Instant::now() + Duration::from_secs(60)),
        })
        .collect();
    let valid = state.session_changes.register(foreign_key);
    let unpolled = state.session_changes.register(key.clone());
    let sockets: Vec<_> = sockets
        .into_iter()
        .map(|mut socket| {
            let changes = state.session_changes.clone();
            let pool = pool.clone();
            tokio::spawn(async move {
                changes.start_rechecks(&pool);
                let result = socket.ended().await;
                (result, socket)
            })
        })
        .collect();
    wait_for_check(&pool).await;
    // Advance across three ticks while SQL is held, without a wall-clock race.
    tokio::time::pause();
    tokio::time::advance(Duration::from_millis(160)).await;
    tokio::time::resume();
    assert_eq!(active_checks(&pool).await, 1);
    assert!(sockets.iter().all(|socket| !socket.is_finished()));
    held.rollback().await.unwrap();
    for socket in sockets {
        let (result, _) = tokio::time::timeout(Duration::from_secs(1), socket)
            .await
            .unwrap()
            .unwrap();
        result.unwrap();
    }
    assert!(!valid.changed.has_changed().unwrap());
    // Missing rows stay latched even for receivers that did not poll during the pass.
    assert!(unpolled.changed.borrow().revoked);
}

#[sqlx::test]
async fn chunked_pass_checks_exact_keys_and_excludes_expired_sessions(pool: PgPool) {
    let (_, auth) = fixture(&pool).await;
    let (_, foreign) = fixture(&pool).await;
    let (_, unregistered) = fixture(&pool).await;
    let key = (auth.identity.organization.organization_id, auth.token_hash);
    let foreign_key = (
        foreign.identity.organization.organization_id,
        foreign.token_hash,
    );
    sqlx::query("UPDATE account_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1")
        .bind(&key.1).execute(&pool).await.unwrap();
    let mut keys: Vec<_> = (0..BATCH_SIZE + 1)
        .map(|_| (Uuid::new_v4(), vec![2; 32]))
        .collect();
    keys[0] = key;
    // Exercise both chunks, including a cross-pair that must not match the valid row.
    keys[1] = (
        unregistered.identity.organization.organization_id,
        vec![2; 32],
    );
    keys.push(foreign_key.clone());
    let checks: Vec<_> = keys.iter().map(|key| (key.0, key.1.clone(), 0)).collect();
    let ended = check(&pool, &checks, Instant::now() + CHECK_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(ended.len(), keys.len() - 1);
    assert!(!ended.contains_key(&foreign_key));
    assert!(ended.values().all(|code| *code == 4001));
}

#[sqlx::test]
async fn multi_chunk_recheck_uses_one_transaction_per_organization(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let (_, active) = fixture(&pools.admin).await;
    let (_, expired) = fixture(&pools.admin).await;
    let (_, inactive) = fixture(&pools.admin).await;
    sqlx::query("UPDATE account_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash=$1")
        .bind(&expired.token_hash).execute(&pools.admin).await.unwrap();
    sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND account_id=$2")
        .bind(inactive.identity.organization.organization_id).bind(inactive.account_id)
        .execute(&pools.admin).await.unwrap();
    crate::database::tests::context::context_policies(&pools.admin).await;
    let mut keys = Vec::new();
    let mut expected = HashMap::new();
    for i in 0..(2 * BATCH_SIZE + 1) {
        for (auth, code) in [
            (&active, None),
            (&expired, Some(4001)),
            (&inactive, Some(4003)),
        ] {
            let hash = if i % 2 == 0 {
                auth.token_hash.clone()
            } else {
                i.to_be_bytes().to_vec()
            };
            let key = (auth.identity.organization.organization_id, hash);
            if let Some(code) = if i % 2 == 0 { code } else { Some(4001) } {
                expected.insert(key.clone(), code);
            }
            keys.push((key.0, key.1, 0));
        }
    }
    let (counted, transactions) = crate::database::tests::context::counted_pool(&pools.app).await;
    assert_eq!(
        check(&counted, &keys, Instant::now() + CHECK_TIMEOUT)
            .await
            .unwrap(),
        expected
    );
    assert_eq!(transactions.load(std::sync::atomic::Ordering::SeqCst), 3);
    counted.close().await;
    pools.app.close().await;
}

#[sqlx::test]
async fn later_organization_failure_applies_no_partial_session_revocations(pool: PgPool) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let changes = SessionChanges::default();
    let registrations: Vec<_> = [Uuid::new_v4(), Uuid::new_v4()]
        .into_iter()
        .flat_map(|org| (0..BATCH_SIZE + 1).map(move |i| (org, i.to_be_bytes().to_vec())))
        .map(|key| changes.register(key))
        .collect();
    let acquisitions = Arc::new(AtomicUsize::new(0));
    let single = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .test_before_acquire(false)
        .before_acquire({
            let acquisitions = acquisitions.clone();
            move |_, _| {
                let later = acquisitions.fetch_add(1, Ordering::SeqCst) > 0;
                Box::pin(async move {
                    if later {
                        std::future::pending::<()>().await;
                    }
                    Ok(true)
                })
            }
        })
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    pass(
        &changes.sessions,
        &single,
        Instant::now() + Duration::from_secs(1),
        &changes.gate,
    )
    .await;
    assert_eq!(
        acquisitions.load(Ordering::SeqCst),
        2,
        "first Organization must finish before the second stalls"
    );
    for registration in registrations {
        let status = *registration.changed.borrow();
        assert!(status.failed);
        assert!(!status.revoked);
        assert!(!status.membership_revoked);
    }
    single.close().await;
}

#[sqlx::test]
async fn timed_out_pass_latches_errors_and_releases_its_pool_connection(pool: PgPool) {
    let (mut state, auth) = fixture(&pool).await;
    let isolated = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(50), Duration::from_millis(200));
    let key = (auth.identity.organization.organization_id, auth.token_hash);
    let mut watches: Vec<_> = (0..32)
        .map(|_| SessionWatch {
            registration: state.session_changes.register(key.clone()),
            deadline: Some(Instant::now() + Duration::from_secs(60)),
        })
        .collect();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE account_sessions IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *held)
        .await
        .unwrap();
    let started = Instant::now();
    state.session_changes.start_rechecks(&isolated);
    wait_for_check(&pool).await;
    for watch in &mut watches {
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), watch.ended())
                .await
                .unwrap(),
            Err(sqlx::Error::PoolTimedOut)
        ));
        let status = watch.registration.changed.borrow();
        assert!(status.failed);
        assert!(!status.revoked);
    }
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(isolated.size(), 0);
    // Keep the table lock: an outstanding query returned to this one-slot pool
    // would prevent a new connection/SELECT from completing within the bound.
    let mut available = tokio::time::timeout(Duration::from_millis(500), isolated.acquire())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT 1")
            .fetch_one(&mut *available)
            .await
            .unwrap(),
        1
    );
    held.rollback().await.unwrap();
}

#[sqlx::test]
async fn deadline_frees_pool_slot_while_transaction_transport_cleanup_is_stalled(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    for statement in [
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "SELECT set_config('fukulow.organization_id', $1, true)",
        "ROLLBACK",
    ] {
        crate::database::tests::interrupted::at_deadline(
            &pools.admin,
            &pools.app,
            statement,
            async |single: &PgPool| {
                check(
                    single,
                    &[(Uuid::new_v4(), vec![1; 32], 0)],
                    Instant::now() + Duration::from_secs(1),
                )
                .await?;
                Ok(())
            },
        )
        .await;
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn unconfirmed_cleanup_frees_fallback_pool_slot_synchronously(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    crate::database::tests::interrupted::failed_rollback(
        &pools.app,
        async |single: &PgPool, pid| {
            assert!(
                check(
                    single,
                    &[(Uuid::new_v4(), vec![1; 32], 0)],
                    Instant::now() + CHECK_TIMEOUT
                )
                .await
                .is_err()
            );
            assert_eq!(single.size(), 0);
            assert_ne!(crate::database::tests::context::clean(single).await, pid);
        },
    )
    .await;
    pools.app.close().await;
}

#[sqlx::test]
async fn reregistration_mid_check_cannot_receive_old_results(pool: PgPool) {
    let (mut state, auth) = fixture(&pool).await;
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(50), CHECK_TIMEOUT);
    let changes = &state.session_changes;
    let key = (
        auth.identity.organization.organization_id,
        auth.token_hash.clone(),
    );
    sqlx::query("DELETE FROM account_sessions WHERE token_hash = $1")
        .bind(&key.1)
        .execute(&pool)
        .await
        .unwrap();
    let old = changes.register(key.clone());
    let queried = changes.pause(Phase::Queried);
    changes.start_rechecks(&pool);
    queried.entered().await;
    // The old epoch's SQL result says missing. Reconnect with a now-valid DB row.
    drop(old);
    sqlx::query("INSERT INTO account_sessions (token_hash, account_id) VALUES ($1, $2)")
        .bind(&key.1)
        .bind(auth.account_id)
        .execute(&pool)
        .await
        .unwrap();
    let new = auth.watch_session(&state).await.unwrap().unwrap();
    let mid_pass = changes.register((key.0, vec![9; 32]));
    let next_snapshot = changes.pause(Phase::Snapshot);
    queried.release();
    next_snapshot.entered().await;
    assert!(!new.registration.changed.borrow().revoked);
    assert!(!new.registration.changed.borrow().failed);
    assert!(!mid_pass.changed.borrow().revoked);
    assert!(!mid_pass.changed.borrow().failed);
    next_snapshot.release();
}

#[sqlx::test]
async fn large_session_pass_fails_closed_by_production_deadline(pool: PgPool) {
    let isolated = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(pool.connect_options().as_ref().clone())
        .await
        .unwrap();
    let held = isolated.acquire().await.unwrap();
    let changes = SessionChanges::default();
    let organization = Uuid::new_v4();
    let registrations: Vec<_> = (0..20_000_u32)
        .map(|i| changes.register((organization, i.to_be_bytes().to_vec())))
        .collect();
    let shared: Vec<_> = (0..100)
        .map(|_| changes.register((organization, vec![0; 4])))
        .collect();
    assert_eq!(changes.sessions.lock().unwrap().entries.len(), 20_000);
    let started_gate = changes.pause(Phase::Started);
    changes.start_rechecks(&isolated);
    started_gate.entered().await;
    tokio::time::pause();
    let started = Instant::now();
    let snapshot = changes.pause(Phase::Snapshot);
    started_gate.release();
    tokio::time::advance(Duration::from_secs(30)).await;
    snapshot.entered().await;
    let later = changes.register((organization, vec![7; 32]));
    let queried = changes.pause(Phase::Queried);
    snapshot.release();
    tokio::time::advance(Duration::from_secs(5)).await;
    queried.entered().await;
    // Tokio's timer wheel rounds deadlines to millisecond ticks.
    assert!(started.elapsed() >= Duration::from_secs(35));
    assert!(started.elapsed() <= Duration::from_secs(35) + Duration::from_millis(2));
    let next_snapshot = changes.pause(Phase::Snapshot);
    queried.release();
    // Wait on the actual latched result, rather than timing a sleeping socket.
    let mut result = registrations[0].changed.clone();
    result.wait_for(|status| status.failed).await.unwrap();
    for registration in registrations.iter().chain(&shared) {
        assert!(registration.changed.borrow().failed);
        assert!(!registration.changed.borrow().revoked);
    }
    assert!(!later.changed.borrow().failed);
    assert!(!later.changed.borrow().revoked);
    tokio::time::resume();
    // Release any next-pass hook if the paused clock reached it.
    next_snapshot.release();
    drop(held);
    isolated.close().await;
}

#[sqlx::test]
#[ignore = "manual many-distinct-sessions measurement; run alone with --ignored --nocapture"]
async fn measure_distinct_session_pass_within_five_seconds(pool: PgPool) {
    // Distinct Accounts/Members spread over ten Organizations; provisioning is untimed.
    sqlx::raw_sql("INSERT INTO organizations (organization_id, name) SELECT lpad(to_hex(1000000+n),32,'0')::uuid, 'Measured Organization' FROM generate_series(0,9) n;
        INSERT INTO accounts (id,email,password_hash) SELECT lpad(to_hex(n),32,'0')::uuid, n::text || '@measurement.example', 'unused' FROM generate_series(1,100000) n;
        INSERT INTO users (organization_id,id,account_id,name,role) SELECT lpad(to_hex(1000000+n%10),32,'0')::uuid, lpad(to_hex(n),32,'0')::uuid, lpad(to_hex(n),32,'0')::uuid, 'Measured Member', 'member' FROM generate_series(1,100000) n;
        INSERT INTO account_sessions (token_hash,account_id) SELECT decode(lpad(to_hex(n),64,'0'),'hex'), lpad(to_hex(n),32,'0')::uuid FROM generate_series(1,100000) n;
        ANALYZE organizations; ANALYZE accounts; ANALYZE users; ANALYZE account_sessions;")
        .execute(&pool).await.unwrap();
    for count in [1_000_u32, 10_000, 100_000] {
        let keys: Vec<_> = (1..=count)
            .map(|i| {
                let mut hash = vec![0; 32];
                hash[28..].copy_from_slice(&i.to_be_bytes());
                (Uuid::from_u128(1_000_000 + u128::from(i % 10)), hash)
            })
            .collect();
        let changes = SessionChanges::default();
        let registrations: Vec<_> = keys
            .iter()
            .enumerate()
            .map(|(i, key)| changes.register_member(key.clone(), Uuid::from_u128(i as u128 + 1), 0))
            .collect();
        let started = Instant::now();
        pass(
            &changes.sessions,
            &pool,
            started + CHECK_TIMEOUT,
            &changes.gate,
        )
        .await;
        for registration in &registrations {
            let status = *registration.changed.borrow();
            assert!(!status.failed);
            assert!(!status.revoked);
            assert!(!status.membership_revoked);
        }
        assert!(started.elapsed() < CHECK_TIMEOUT);
        eprintln!(
            "DISTINCT_SESSION_PASS organizations=10 accounts={count} members={count} sessions={count} chunks={} elapsed_ms={:.3} deadline_ms=5000",
            keys.len().div_ceil(BATCH_SIZE),
            started.elapsed().as_secs_f64() * 1000.0
        );
    }
}

#[sqlx::test]
async fn failed_check_result_cannot_fail_reconnected_epoch(pool: PgPool) {
    let (mut state, auth) = fixture(&pool).await;
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(50), Duration::from_millis(200));
    let changes = &state.session_changes;
    let key = (
        auth.identity.organization.organization_id,
        auth.token_hash.clone(),
    );
    let old = changes.register(key.clone());
    let mut held = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE account_sessions IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *held)
        .await
        .unwrap();
    let queried = changes.pause(Phase::Queried);
    changes.start_rechecks(&pool);
    queried.entered().await;
    // This pass has timed out. Its error belongs only to the disconnected epoch.
    drop(old);
    held.rollback().await.unwrap();
    let new = auth.watch_session(&state).await.unwrap().unwrap();
    let next_snapshot = changes.pause(Phase::Snapshot);
    queried.release();
    next_snapshot.entered().await;
    assert!(!new.registration.changed.borrow().failed);
    assert!(!new.registration.changed.borrow().revoked);
    next_snapshot.release();
}

#[sqlx::test]
async fn batch_recheck_distinguishes_session_end_membership_loss_and_valid_sessions(pool: PgPool) {
    let (state, auth) = fixture(&pool).await;
    let (_, expired) = fixture(&pool).await;
    let (_, inactive) = fixture(&pool).await;
    let (_, valid) = fixture(&pool).await;
    let mut ended_session = auth.watch_session(&state).await.unwrap().unwrap();
    let mut expired_session = expired.watch_session(&state).await.unwrap().unwrap();
    let mut inactive_membership = inactive.watch_session(&state).await.unwrap().unwrap();
    let valid_membership = valid.watch_session(&state).await.unwrap().unwrap();
    sqlx::query("DELETE FROM account_sessions WHERE token_hash = $1")
        .bind(&auth.token_hash)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE account_sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1").bind(&expired.token_hash).execute(&pool).await.unwrap();
    sqlx::query("UPDATE users SET deactivated_at = clock_timestamp() WHERE organization_id = $1 AND account_id = $2")
        .bind(inactive.identity.organization.organization_id).bind(inactive.account_id).execute(&pool).await.unwrap();
    pass(
        &state.session_changes.sessions,
        &pool,
        Instant::now() + CHECK_TIMEOUT,
        &state.session_changes.gate,
    )
    .await;
    assert_eq!(ended_session.ended().await.unwrap(), 4001);
    assert_eq!(expired_session.ended().await.unwrap(), 4001);
    assert_eq!(inactive_membership.ended().await.unwrap(), 4003);
    assert!(!valid_membership.registration.changed.has_changed().unwrap());
    // Even when both causes apply, an ended Account Session always means Sign in.
    sqlx::query("DELETE FROM account_sessions WHERE token_hash = $1")
        .bind(&inactive.token_hash)
        .execute(&pool)
        .await
        .unwrap();
    let key = (
        inactive.identity.organization.organization_id,
        inactive.token_hash.clone(),
        0,
    );
    assert_eq!(
        check(
            &pool,
            std::slice::from_ref(&key),
            Instant::now() + CHECK_TIMEOUT
        )
        .await
        .unwrap()[&(key.0, key.1)],
        4001
    );
}

#[sqlx::test]
async fn lost_signal_deactivate_reactivate_still_revokes_stale_membership_revision(pool: PgPool) {
    let (mut state, mut auth) = fixture(&pool).await;
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(50), CHECK_TIMEOUT);
    let mut stale = auth.watch_session(&state).await.unwrap().unwrap();
    sqlx::query("UPDATE users SET deactivated_at = clock_timestamp() WHERE organization_id = $1 AND account_id = $2")
        .bind(auth.identity.organization.organization_id).bind(auth.account_id).execute(&pool).await.unwrap();
    sqlx::query(
        "UPDATE users SET deactivated_at = NULL WHERE organization_id = $1 AND account_id = $2",
    )
    .bind(auth.identity.organization.organization_id)
    .bind(auth.account_id)
    .execute(&pool)
    .await
    .unwrap();
    // No signal: the single fallback pass compares the revision captured at connect.
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), stale.ended())
            .await
            .unwrap()
            .unwrap(),
        4003
    );
    assert!(!stale.registration.changed.borrow().revoked);
    auth.membership_revision = 1;
    let fresh = auth.watch_session(&state).await.unwrap().unwrap();
    assert!(!fresh.registration.changed.borrow().membership_revoked);
    assert!(!fresh.registration.changed.borrow().revoked);
    assert!(
        !fresh
            .registration
            .guard
            .epoch
            .same_channel(&stale.registration.guard.epoch)
    );
}

#[sqlx::test]
async fn deadline_includes_query_result_application(pool: PgPool) {
    let (state, auth) = fixture(&pool).await;
    let mut socket = auth.watch_session(&state).await.unwrap().unwrap();
    let queried = state.session_changes.pause(Phase::Queried);
    let started = Instant::now();
    let pass = pass(
        &state.session_changes.sessions,
        &pool,
        started + CHECK_TIMEOUT,
        &state.session_changes.gate,
    );
    tokio::pin!(pass);
    tokio::select! {
        _ = &mut pass => panic!("pass did not pause after SQL"),
        _ = queried.entered() => {},
    }
    tokio::time::pause();
    tokio::time::advance(CHECK_TIMEOUT).await;
    queried.release();
    pass.await;
    assert!(matches!(
        socket.ended().await,
        Err(sqlx::Error::PoolTimedOut)
    ));
    assert!(!socket.registration.changed.borrow().revoked);
    assert!(!socket.registration.changed.borrow().membership_revoked);
    tokio::time::resume();
}

#[sqlx::test]
async fn rechecks_scope_each_organization_and_preserve_revocation_causes(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let (_, first) = fixture(&pools.admin).await;
    let (_, second) = fixture(&pools.admin).await;
    crate::database::tests::context::context_policies(&pools.admin).await;
    let key = |auth: &Auth| {
        (
            auth.identity.organization.organization_id,
            auth.token_hash.clone(),
            auth.membership_revision,
        )
    };
    let keys = vec![key(&first), key(&second)];
    // A single mixed batch must retain both valid Members under restricted RLS.
    assert!(
        check(&pools.app, &keys, Instant::now() + CHECK_TIMEOUT)
            .await
            .unwrap()
            .is_empty()
    );
    let mut state = AppState::for_test(pools.app.clone());
    state.session_changes = SessionChanges::default().with_on_fatal(Arc::new(|| {}));
    let mut first_watch = first.watch_session(&state).await.unwrap().unwrap();
    let second_watch = second.watch_session(&state).await.unwrap().unwrap();
    // Use the actual fallback pass, including registration epochs and result application.
    sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND account_id=$2")
        .bind(keys[0].0).bind(first.account_id).execute(&pools.admin).await.unwrap();
    pass(
        &state.session_changes.sessions,
        &pools.app,
        Instant::now() + CHECK_TIMEOUT,
        &state.session_changes.gate,
    )
    .await;
    assert_eq!(first_watch.ended().await.unwrap(), 4003);
    assert!(!second_watch.registration.changed.has_changed().unwrap());
    sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
        .bind(&keys[0].1)
        .execute(&pools.admin)
        .await
        .unwrap();
    let ended = check(&pools.app, &keys, Instant::now() + CHECK_TIMEOUT)
        .await
        .unwrap();
    assert_eq!(ended.len(), 1);
    assert_eq!(ended[&(keys[0].0, keys[0].1.clone())], 4001);
    pools.app.close().await;
}
