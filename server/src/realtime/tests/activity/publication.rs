use super::*;

#[fukulow_test::test]
async fn mutation_notice_is_not_observable_before_confirmed_commit(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, other) = member(&pool, f.organization).await;
    let mut reader = connect(&f, &other).await;
    let key = Uuid::new_v4();
    let gate = messages::pause_commit(key);
    let task = tokio::spawn({
        let app = f.app.clone();
        let token = f.token.clone();
        let channel = f.channel;
        async move {
            request(
                &app,
                "POST",
                &format!("/api/v1/channels/{channel}/messages"),
                &token,
                json!({"client_message_id":key,"body":"paused"}),
            )
            .await
        }
    });
    gate.entered().await;
    assert!(notices(&f, &mut reader).await.is_empty());
    gate.release();
    assert_eq!(task.await.unwrap().status(), StatusCode::CREATED);
    assert_eq!(notices(&f, &mut reader).await, vec![activity(f.channel, 1)]);
}
#[fukulow_test::test]
async fn proven_rollback_and_refused_mutations_publish_no_mutation_notice(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, other) = member(&pool, f.organization).await;
    let mut reader = connect(&f, &other).await;
    let denied = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages", f.channel),
        &f.token,
        json!({"client_message_id":Uuid::new_v4(),"body":""}),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::BAD_REQUEST);
    sqlx::raw_sql("CREATE FUNCTION rollback_activity_send() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body='proven rollback' THEN RAISE EXCEPTION 'injected rollback' USING ERRCODE='23514'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER rollback_activity_send AFTER INSERT ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rollback_activity_send()")
        .execute(&pool).await.unwrap();
    let rolled_back = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages", f.channel),
        &f.token,
        json!({"client_message_id":Uuid::new_v4(),"body":"proven rollback"}),
    )
    .await;
    assert_eq!(rolled_back.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(notices(&f, &mut reader).await.is_empty());
    post(&f, f.channel).await;
    assert_eq!(notices(&f, &mut reader).await, vec![activity(f.channel, 1)]);
}

#[fukulow_test::test]
async fn failed_publication_never_resets_unproven_recipients(pool: PgPool) {
    use crate::channels::activity::{TestFault, fail, pause};
    for failure in ["capacity", "database", "timeout", "cancel", "panic"] {
        let f = fixture(&pool).await;
        let (control, control_token) = member(&pool, f.organization).await;
        let (_, private_denied) = member(&pool, f.organization).await;
        let (guest, guest_token) = member(&pool, f.organization).await;
        role(&pool, &f, guest, "guest").await;
        let foreign_org = organization(&pool).await;
        let (_, foreign_token) = member(&pool, foreign_org).await;
        let private = channel(&pool, f.organization, f.member, true).await;
        grant(&pool, &f, private, control).await;
        let mut allowed = connect(&f, &control_token).await;
        let mut denied = Vec::new();
        for token in [&private_denied, &guest_token, &foreign_token] {
            denied.push(connect(&f, token).await);
        }
        post(&f, private).await;
        assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 1)]);
        for socket in &mut denied {
            assert!(notices(&f, socket).await.is_empty());
        }
        let delivery = &f.state.message_delivery.channel_access.activity;
        let capacity = if failure == "capacity" {
            Some(delivery.saturate().await)
        } else {
            None
        };
        let gate = if matches!(failure, "timeout" | "cancel") {
            Some(pause(f.organization, private, "query"))
        } else {
            None
        };
        if failure == "database" {
            fail(f.organization, private, TestFault::Database)
        }
        if failure == "panic" {
            fail(f.organization, private, TestFault::Panic)
        }
        post(&f, private).await;
        if let Some(gate) = &gate {
            gate.entered().await;
            if failure == "cancel" {
                delivery.cancel(f.organization, private)
            }
        }
        drop(capacity);
        for socket in &mut denied {
            assert!(notices(&f, socket).await.is_empty(), "failure={failure}");
        }
        assert!(
            notices(&f, &mut allowed).await.is_empty(),
            "failure={failure}"
        );
        // Independent O5 REST reconciliation, without a subsequent mutation, obtains the committed badge.
        let response = request(
            &f.app,
            "GET",
            "/api/v1/channels",
            &control_token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
        let row = body["channels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == private.to_string())
            .unwrap();
        assert_eq!(row["unread_count"], 2, "failure={failure}");
    }
}
#[fukulow_test::test]
async fn delayed_commit_after_successful_recovery_fetch_converges_without_later_mutation(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (_, token) = member(&pool, f.organization).await;
    let mut socket = connect(&f, &token).await;
    let key = Uuid::new_v4();
    let commit = messages::ambiguous_commit(key);
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages", f.channel),
        &f.token,
        json!({"client_message_id":key,"body":"uncertain"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    let transaction = commit.await.unwrap();
    for reconnect in [false, true] {
        if reconnect {
            socket.close(None).await.unwrap();
            socket = connect(&f, &token).await;
        }
        let response = request(&f.app, "GET", "/api/v1/channels", &token, Value::Null).await;
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
        assert_eq!(body["channels"][0]["unread_count"], 0);
    }
    transaction.commit().await.unwrap();
    assert!(notices(&f, &mut socket).await.is_empty());
    let response = request(&f.app, "GET", "/api/v1/channels", &token, Value::Null).await;
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    assert_eq!(body["channels"][0]["unread_count"], 1);
}

#[fukulow_test::test]
async fn failed_directory_publication_never_resets_invisible_guests(pool: PgPool) {
    use crate::auth::activity::ActivityChanges;
    use crate::channels::activity::{TestFault, fail, pause};
    for failure in ["capacity", "database", "timeout", "cancel", "panic"] {
        let f = fixture(&pool).await;
        owner(&pool, &f).await;
        let (target, _) = member(&pool, f.organization).await;
        let (guest, guest_token) = member(&pool, f.organization).await;
        role(&pool, &f, guest, "guest").await;
        let mut allowed = connect(&f, &f.token).await;
        let mut invisible = connect(&f, &guest_token).await;
        let delivery = &f.state.message_delivery.channel_access.activity;
        delivery.directory(f.state.pool.clone(), f.organization, target);
        assert_eq!(
            notices(&f, &mut allowed).await,
            vec![json!({"type":"members_changed"})]
        );
        assert!(notices(&f, &mut invisible).await.is_empty());
        // Commit the outcome before injecting failure into the ordinary post-COMMIT hook.
        role(&pool, &f, target, "admin").await;
        let capacity = if failure == "capacity" {
            Some(delivery.saturate().await)
        } else {
            None
        };
        let gate = if matches!(failure, "timeout" | "cancel") {
            Some(pause(f.organization, Uuid::nil(), "query"))
        } else {
            None
        };
        if failure == "database" {
            fail(f.organization, Uuid::nil(), TestFault::Database);
        }
        if failure == "panic" {
            fail(f.organization, Uuid::nil(), TestFault::Panic);
        }
        delivery.directory(f.state.pool.clone(), f.organization, target);
        if let Some(gate) = &gate {
            gate.entered().await;
            if failure == "cancel" {
                delivery.cancel(f.organization, Uuid::nil());
            }
        }
        drop(capacity);
        assert!(notices(&f, &mut invisible).await.is_empty(), "{failure}");
        assert!(notices(&f, &mut allowed).await.is_empty(), "{failure}");
        let response = request(
            &f.app,
            "GET",
            &format!("/api/v1/orgs/{}/members", f.organization),
            &f.token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
        assert!(
            body["members"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["id"] == target.to_string() && row["role"] == "admin")
        );
    }
}
