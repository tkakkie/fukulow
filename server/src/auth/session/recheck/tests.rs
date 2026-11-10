use super::*;
use crate::auth::session::tests::fixture;

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
            tokio::time::sleep(Duration::from_millis(5)).await;
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
    tokio::time::sleep(Duration::from_millis(160)).await; // More than three ticks, while SQL is blocked.
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
        check(&pool, &keys, CHECK_TIMEOUT).await.unwrap(),
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

#[tokio::test]
async fn production_pass_timing_keeps_the_35_second_bound() {
    let changes = SessionChanges::default();
    assert_eq!(changes.interval, Duration::from_secs(30));
    assert_eq!(changes.timeout, Duration::from_secs(5));
    assert_eq!(changes.interval + changes.timeout, Duration::from_secs(35));
}
