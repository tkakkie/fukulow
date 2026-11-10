use super::*;

async fn failed_send(f: &Fixture, key: Uuid, body: &str) {
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages", f.channel),
        &f.token,
        json!({"client_message_id": key, "body": body}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = to_bytes(response.into_body(), 32 * 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"error":"internal error"})
    );
}

async fn waiting_for_commit(pool: &PgPool, pid: i32) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_locks waiter JOIN pg_locks holder \
                 USING (locktype, database, classid, objid, objsubid) \
                 WHERE holder.pid = $1 AND holder.granted AND waiter.mode = 'ShareLock' \
                 AND NOT waiter.granted AND waiter.locktype = 'advisory')",
            )
            .bind(pid)
            .fetch_one(pool)
            .await
            .unwrap();
            if waiting {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[sqlx::test]
async fn ambiguous_commit_visible_after_failure_signal_replays_without_a_later_send(pool: PgPool) {
    // Cover both the first allocation (no committed sequence row) and an existing counter.
    for initial_seq in [0, 1] {
        let f = fixture(&pool).await;
        if initial_seq == 1 {
            post(&f, f.channel).await;
        }
        let mut before = f.server.connect(&f.token).await;
        subscribe(&mut before, f.channel, initial_seq).await;
        ready(&mut before, f.channel, initial_seq).await;
        let mut during = f.server.connect(&f.token).await;
        let replay = pause(f.channel);
        subscribe(&mut during, f.channel, initial_seq).await;
        entered(&replay).await;

        let key = Uuid::new_v4();
        let pending = messages::ambiguous_commit(key);
        failed_send(&f, key, "ambiguous").await;
        let mut tx = pending.await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(tx.connection().unwrap())
            .await
            .unwrap();
        closed(&mut before, 1011).await;
        closed(&mut during, 1011).await;

        // This is the old gap: signal observed, but the final Message is still invisible.
        let mut between = f.server.connect(&f.token).await;
        subscribe(&mut between, f.channel, initial_seq).await;
        tokio::select! {
            _ = waiting_for_commit(&pool, pid) => {},
            stale = event(&mut between) => panic!("handoff before COMMIT resolved: {stale}"),
        }
        let visible =
            messages::replay_page(&pool, f.organization, f.channel, initial_seq, i64::MAX)
                .await
                .unwrap();
        assert!(visible.is_empty());

        // A concurrent same-key retry must wait for the original outcome, then use its row.
        let app = f.app.clone();
        let token = f.token.clone();
        let channel = f.channel;
        let mut retry = tokio::spawn(async move {
            request(
                &app,
                "POST",
                &format!("/api/v1/channels/{channel}/messages"),
                &token,
                json!({"client_message_id": key, "body": "ambiguous"}),
            )
            .await
        });
        // The original transaction still owns Channel admission, so the retry
        // cannot reach PostgreSQL's lock wait until that permit is released.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut retry)
                .await
                .is_err(),
            "the original transaction owns admission"
        );
        tx.commit().await.unwrap();
        let response = retry.await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let canonical: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 32 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(canonical["seq"], initial_seq + 1);
        assert_eq!(event(&mut between).await["message"], canonical);
        ready(&mut between, f.channel, initial_seq + 1).await;

        let mut after = f.server.connect(&f.token).await;
        subscribe(&mut after, f.channel, initial_seq).await;
        assert_eq!(event(&mut after).await["message"], canonical);
        ready(&mut after, f.channel, initial_seq + 1).await;
        assert_eq!(
            send(&f, &f.token, f.channel, key, "ambiguous").await,
            canonical
        );
        assert_eq!(
            f.state
                .message_delivery
                .latest_seq(&pool, f.organization, f.channel)
                .await
                .unwrap(),
            initial_seq + 1
        );
        f.state.message_delivery.flush().await;
        silent(&mut between).await;
        silent(&mut after).await;
    }
}

#[sqlx::test]
async fn ambiguous_commit_rollback_allows_gap_free_same_key_retry(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut before = f.server.connect(&f.token).await;
    subscribe(&mut before, f.channel, 0).await;
    ready(&mut before, f.channel, 0).await;
    let key = Uuid::new_v4();
    let pending = messages::ambiguous_commit(key);
    failed_send(&f, key, "rolled back").await;
    let mut tx = pending.await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(tx.connection().unwrap())
        .await
        .unwrap();
    closed(&mut before, 1011).await;
    let mut between = f.server.connect(&f.token).await;
    subscribe(&mut between, f.channel, 0).await;
    waiting_for_commit(&pool, pid).await;
    tx.rollback().await.unwrap();
    ready(&mut between, f.channel, 0).await;
    silent(&mut between).await;
    assert!(
        messages::replay_page(&pool, f.organization, f.channel, 0, i64::MAX)
            .await
            .unwrap()
            .is_empty()
    );
    let canonical = send(&f, &f.token, f.channel, key, "rolled back").await;
    assert_eq!(canonical["seq"], 1);
    assert_eq!(event(&mut between).await["message"], canonical);
    assert_eq!(
        send(&f, &f.token, f.channel, key, "rolled back").await,
        canonical
    );
    assert_eq!(
        f.state
            .message_delivery
            .latest_seq(&pool, f.organization, f.channel)
            .await
            .unwrap(),
        1
    );
    f.state.message_delivery.flush().await;
    silent(&mut between).await;
}

#[sqlx::test]
async fn definite_commit_failure_does_not_signal_or_consume_sequence(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    let mut queue = f.state.message_delivery.queue(f.organization, f.member, 1);
    queue.subscribe(f.channel);
    sqlx::raw_sql(
        "CREATE FUNCTION reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN RAISE EXCEPTION 'definite rollback' USING ERRCODE = '23514'; END $$; \
         CREATE CONSTRAINT TRIGGER reject_commit AFTER INSERT ON messages \
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_commit();",
    )
    .execute(&pool)
    .await
    .unwrap();
    let key = Uuid::new_v4();
    failed_send(&f, key, "definite").await;
    assert!(!queue.notification_failed.is_failed());
    assert!(queue.events.try_recv().is_err());
    assert_eq!(
        f.state
            .message_delivery
            .latest_seq(&pool, f.organization, f.channel)
            .await
            .unwrap(),
        0
    );
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    silent(&mut socket).await;
    sqlx::query("DROP TRIGGER reject_commit ON messages")
        .execute(&pool)
        .await
        .unwrap();
    let canonical = send(&f, &f.token, f.channel, key, "definite").await;
    assert_eq!(canonical["seq"], 1);
    assert_eq!(event(&mut socket).await["message"], canonical);
}

#[sqlx::test]
async fn unresolved_commit_subscription_timeout_closes_and_later_reconnect_recovers(pool: PgPool) {
    let f = fixture(&pool).await;
    let key = Uuid::new_v4();
    let pending = messages::ambiguous_commit(key);
    failed_send(&f, key, "late commit").await;
    let mut tx = pending.await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(tx.connection().unwrap())
        .await
        .unwrap();
    let mut waiting = f.server.connect(&f.token).await;
    subscribe(&mut waiting, f.channel, 0).await;
    waiting_for_commit(&pool, pid).await;
    tokio::time::pause();
    tokio::time::advance(messages::NOTIFICATION_TIMEOUT).await;
    tokio::time::resume();
    closed(&mut waiting, 1011).await;
    tx.commit().await.unwrap();
    let mut recovered = f.server.connect(&f.token).await;
    subscribe(&mut recovered, f.channel, 0).await;
    let message = event(&mut recovered).await;
    assert_eq!(message["message"]["client_message_id"], json!(key));
    assert_eq!(message["message"]["seq"], 1);
    ready(&mut recovered, f.channel, 1).await;
}

#[sqlx::test]
async fn ambiguous_commit_recovery_preserves_organization_and_private_channel_denials(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    sqlx::query(
        "UPDATE channels SET visibility = 'private' WHERE organization_id = $1 AND id = $2",
    )
    .bind(f.organization)
    .bind(f.channel)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $2, $3)",
    )
    .bind(f.organization)
    .bind(f.channel)
    .bind(f.member)
    .execute(&pool)
    .await
    .unwrap();
    let (_, nonmember) = member(&pool, f.organization).await;
    let other_channel = channel(&pool, f.organization, f.member, false).await;
    let foreign = fixture(&pool).await;
    sqlx::query("INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, 'Foreign', 'public')")
        .bind(foreign.organization).bind(f.channel).execute(&pool).await.unwrap();
    let mut owner = f.server.connect(&f.token).await;
    let mut unrelated = f.server.connect(&f.token).await;
    let mut other_org = f.server.connect(&foreign.token).await;
    for (socket, channel) in [
        (&mut owner, f.channel),
        (&mut unrelated, other_channel),
        (&mut other_org, f.channel),
    ] {
        subscribe(socket, channel, 0).await;
        ready(socket, channel, 0).await;
    }
    let key = Uuid::new_v4();
    let pending = messages::ambiguous_commit(key);
    failed_send(&f, key, "private").await;
    let mut tx = pending.await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(tx.connection().unwrap())
        .await
        .unwrap();
    closed(&mut owner, 1011).await;
    let mut recovery = f.server.connect(&f.token).await;
    subscribe(&mut recovery, f.channel, 0).await;
    waiting_for_commit(&pool, pid).await;

    let mut denied_socket = f.server.connect(&nonmember).await;
    subscribe(&mut denied_socket, f.channel, 0).await;
    denied(&mut denied_socket, f.channel).await;
    subscribe(&mut other_org, f.channel, 0).await;
    ready(&mut other_org, f.channel, 0).await;
    subscribe(&mut unrelated, other_channel, 0).await;
    ready(&mut unrelated, other_channel, 0).await;
    // A foreign Organization still cannot subscribe to this Organization's other Channel.
    subscribe(&mut other_org, other_channel, 0).await;
    denied(&mut other_org, other_channel).await;
    tx.commit().await.unwrap();
    assert_eq!(
        event(&mut recovery).await["message"]["client_message_id"],
        json!(key)
    );
    ready(&mut recovery, f.channel, 1).await;
    subscribe(&mut denied_socket, f.channel, 0).await;
    denied(&mut denied_socket, f.channel).await;
    let own = post(&f, other_channel).await;
    assert_eq!(event(&mut unrelated).await["message"], own);
    let own = send(&f, &foreign.token, f.channel, Uuid::new_v4(), "foreign").await;
    assert_eq!(event(&mut other_org).await["message"], own);
    f.state.message_delivery.flush().await;
    silent(&mut denied_socket).await;
    silent(&mut recovery).await;
}

#[sqlx::test]
async fn send_deadline_during_commit_signals_and_reconnect_waits_for_final_message(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut before = f.server.connect(&f.token).await;
    subscribe(&mut before, f.channel, 0).await;
    ready(&mut before, f.channel, 0).await;
    let mut blocker = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(156::bigint)")
        .execute(&mut *blocker)
        .await
        .unwrap();
    let holder: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION pause_commit_deadline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(156::bigint); RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER pause_commit_deadline AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pause_commit_deadline();").execute(&pool).await.unwrap();
    let key = Uuid::new_v4();
    let app = f.app.clone();
    let token = f.token.clone();
    let channel = f.channel;
    let sending = tokio::spawn(async move {
        request(
            &app,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            json!({"client_message_id": key, "body": "deadline"}),
        )
        .await
    });
    let committing = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let pid: Option<i32> = sqlx::query_scalar("SELECT pid FROM pg_stat_activity WHERE query = 'COMMIT' AND $1 = ANY(pg_blocking_pids(pid))")
                .bind(holder).fetch_optional(&pool).await.unwrap();
            if let Some(pid) = pid { break pid; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    tokio::time::pause();
    tokio::time::advance(messages::NOTIFICATION_TIMEOUT).await;
    tokio::time::resume();
    assert_eq!(
        sending.await.unwrap().status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    closed(&mut before, 1011).await;
    let mut recovered = f.server.connect(&f.token).await;
    subscribe(&mut recovered, f.channel, 0).await;
    tokio::select! {
        _ = waiting_for_commit(&pool, committing) => {},
        stale = event(&mut recovered) => panic!("handoff before timed-out COMMIT resolved: {stale}"),
    }
    blocker.commit().await.unwrap();
    let canonical = event(&mut recovered).await["message"].clone();
    assert_eq!(canonical["client_message_id"], json!(key));
    assert_eq!(canonical["seq"], 1);
    ready(&mut recovered, f.channel, 1).await;
    assert_eq!(
        send(&f, &f.token, f.channel, key, "deadline").await,
        canonical
    );
    silent(&mut recovered).await;
}

#[sqlx::test]
async fn send_deadline_during_sleeping_commit_ends_backend_and_releases_locks(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut before = f.server.connect(&f.token).await;
    subscribe(&mut before, f.channel, 0).await;
    ready(&mut before, f.channel, 0).await;
    sqlx::raw_sql(
        "CREATE FUNCTION sleep_commit() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN PERFORM pg_sleep(60); RETURN NEW; END $$; \
         CREATE CONSTRAINT TRIGGER sleep_commit AFTER INSERT ON messages \
         DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sleep_commit();",
    )
    .execute(&pool)
    .await
    .unwrap();
    let key = Uuid::new_v4();
    let app = f.app.clone();
    let token = f.token.clone();
    let channel = f.channel;
    let sending = tokio::spawn(async move {
        request(
            &app,
            "POST",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            json!({"client_message_id": key, "body": "unknown then rolled back"}),
        )
        .await
    });
    let pid: i32 = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let pid = sqlx::query_scalar(
                "SELECT pid FROM pg_stat_activity \
                WHERE datname = current_database() AND query = 'COMMIT' AND wait_event = 'PgSleep'",
            )
            .fetch_optional(&pool)
            .await
            .unwrap();
            if let Some(pid) = pid {
                break pid;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let started = std::time::Instant::now();
    // Advance only the HTTP work clock; PostgreSQL's real timeout is unchanged.
    tokio::time::pause();
    tokio::time::advance(messages::NOTIFICATION_TIMEOUT).await;
    tokio::time::resume();
    assert_eq!(
        sending.await.unwrap().status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    closed(&mut before, 1011).await;
    let locks: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_locks WHERE pid = $1")
        .bind(pid)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        locks > 0,
        "socket abandonment alone must leave the injected COMMIT unresolved"
    );
    // The reconnecting watermark's timer starts after the sender's, leaving ordering margin.
    let mut between = f.server.connect(&f.token).await;
    subscribe(&mut between, channel, 0).await;
    tokio::select! {
        _ = waiting_for_commit(&pool, pid) => {},
        stale = event(&mut between) => panic!("handoff before COMMIT resolved: {stale}"),
    }
    tokio::time::timeout(Duration::from_secs(9), async {
        loop {
            let residue: i64 = sqlx::query_scalar(
                "SELECT (SELECT count(*) FROM pg_stat_activity WHERE pid = $1) + \
                 (SELECT count(*) FROM pg_locks WHERE pid = $1)",
            )
            .bind(pid)
            .fetch_one(&pool)
            .await
            .unwrap();
            if residue == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("PostgreSQL must end the disconnected backend and release every lock");
    eprintln!(
        "abandoned_commit pid={pid} initial_locks={locks} backend_and_locks_gone_ms={}",
        started.elapsed().as_millis()
    );
    ready(&mut between, channel, 0).await;
    assert!(
        messages::replay_page(&pool, f.organization, channel, 0, i64::MAX)
            .await
            .unwrap()
            .is_empty()
    );
    sqlx::query("DROP TRIGGER sleep_commit ON messages")
        .execute(&pool)
        .await
        .unwrap();
    let canonical = send(&f, &f.token, channel, key, "unknown then rolled back").await;
    assert_eq!(canonical["seq"], 1);
    assert_eq!(event(&mut between).await["message"], canonical);
    assert_eq!(
        send(&f, &f.token, channel, key, "unknown then rolled back").await,
        canonical
    );
    let next = post(&f, channel).await;
    assert_eq!(next["seq"], 2);
    assert_eq!(event(&mut between).await["message"], next);
    let mut replay = f.server.connect(&f.token).await;
    subscribe(&mut replay, channel, 0).await;
    assert_eq!(event(&mut replay).await["message"], canonical);
    assert_eq!(event(&mut replay).await["message"], next);
    ready(&mut replay, channel, 2).await;
    f.state.message_delivery.flush().await;
    silent(&mut between).await;
    silent(&mut replay).await;
}
