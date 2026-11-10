use super::*;
use crate::auth::session::tests::{Phase, fixture};

mod exit;

async fn active_checks(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() \
         AND state = 'active' AND query LIKE $1",
    )
    .bind("SELECT sessions.organization_id, sessions.token_hash FROM sessions%")
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
    sqlx::query("DELETE FROM sessions WHERE organization_id = $1")
        .bind(key.0)
        .execute(&pool)
        .await
        .unwrap();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE")
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
            deadline: Instant::now() + Duration::from_secs(60),
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
    sqlx::query("UPDATE sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE organization_id = $1")
        .bind(key.0).execute(&pool).await.unwrap();
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
    assert_eq!(
        check(&pool, &keys, Instant::now() + CHECK_TIMEOUT)
            .await
            .unwrap(),
        HashSet::from([foreign_key])
    );
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
            deadline: Instant::now() + Duration::from_secs(60),
        })
        .collect();
    let mut held = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE")
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
async fn reregistration_mid_check_cannot_receive_old_results(pool: PgPool) {
    let (mut state, auth) = fixture(&pool).await;
    state.session_changes =
        SessionChanges::with_recheck_timing(Duration::from_millis(50), CHECK_TIMEOUT);
    let changes = &state.session_changes;
    let key = (
        auth.identity.organization.organization_id,
        auth.token_hash.clone(),
    );
    sqlx::query("DELETE FROM sessions WHERE organization_id = $1")
        .bind(key.0)
        .execute(&pool)
        .await
        .unwrap();
    let old = changes.register(key.clone());
    let queried = changes.pause(Phase::Queried);
    changes.start_rechecks(&pool);
    queried.entered().await;
    // The old epoch's SQL result says missing. Reconnect with a now-valid DB row.
    drop(old);
    sqlx::query("INSERT INTO sessions (organization_id, token_hash, user_id) VALUES ($1, $2, $3)")
        .bind(key.0)
        .bind(&key.1)
        .bind(auth.identity.member.id)
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
    let (_, auth) = fixture(&pool).await;
    let organization = auth.identity.organization.organization_id;
    // 32-byte unique hashes; provision outside the timed pass.
    sqlx::query(
        "INSERT INTO sessions (organization_id, token_hash, user_id) \
        SELECT $1, decode(lpad(to_hex(n), 64, '0'), 'hex'), $2 \
        FROM generate_series(1, 100000) AS n",
    )
    .bind(organization)
    .bind(auth.identity.member.id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("ANALYZE sessions")
        .execute(&pool)
        .await
        .unwrap();
    for count in [1_000_u32, 10_000, 100_000] {
        let keys: Vec<_> = (1..=count)
            .map(|i| {
                let mut hash = vec![0; 32];
                hash[28..].copy_from_slice(&i.to_be_bytes());
                (organization, hash)
            })
            .collect();
        let changes = SessionChanges::default();
        let registrations: Vec<_> = keys
            .iter()
            .map(|key| changes.register(key.clone()))
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
        }
        assert!(started.elapsed() < CHECK_TIMEOUT);
        eprintln!(
            "DISTINCT_SESSION_PASS sessions={count} chunks={} elapsed_ms={:.3} deadline_ms=5000",
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
    sqlx::query("LOCK TABLE sessions IN ACCESS EXCLUSIVE MODE")
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
