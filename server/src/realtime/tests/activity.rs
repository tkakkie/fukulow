use super::*;

async fn raw_event(socket: &mut Client) -> Value {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        {
            tungstenite::Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            tungstenite::Message::Ping(_) => socket.flush().await.unwrap(),
            other => panic!("expected notice, got {other:?}"),
        }
    }
}
async fn connect(f: &Fixture, token: &str) -> Client {
    let mut socket = f.server.connect(token).await;
    assert_eq!(
        raw_event(&mut socket).await,
        json!({"type":"activity_ready"})
    );
    socket
}
async fn notices(f: &Fixture, socket: &mut Client) -> Vec<Value> {
    collect(&f.state.message_delivery.channel_access.activity, socket).await
}
pub(super) async fn collect(
    delivery: &crate::channels::activity::Activity,
    socket: &mut Client,
) -> Vec<Value> {
    delivery.drained().await;
    let nonce = Uuid::new_v4().as_bytes().to_vec();
    socket
        .send(tungstenite::Message::Ping(nonce.clone().into()))
        .await
        .unwrap();
    let mut result = Vec::new();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match frame {
            tungstenite::Message::Pong(bytes) if bytes.as_ref() == nonce => return result,
            tungstenite::Message::Ping(_) => socket.flush().await.unwrap(),
            tungstenite::Message::Text(text) => {
                let notice: Value = serde_json::from_str(&text).unwrap();
                assert!(
                    serde_json::from_value::<crate::channels::activity::Notice>(notice.clone())
                        .is_ok(),
                    "unexpected body/personal data: {notice}"
                );
                result.push(notice);
            }
            other => panic!("unexpected activity frame: {other:?}"),
        }
    }
}
async fn grant(pool: &PgPool, f: &Fixture, channel: Uuid, target: Uuid) {
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(f.organization)
    .bind(channel)
    .bind(target)
    .execute(pool)
    .await
    .unwrap();
}
async fn owner(pool: &PgPool, f: &Fixture) {
    sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(f.member)
        .execute(pool)
        .await
        .unwrap();
}
async fn role(pool: &PgPool, f: &Fixture, target: Uuid, value: &str) {
    sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(target)
        .bind(value)
        .execute(pool)
        .await
        .unwrap();
}
fn activity(channel: Uuid, seq: i64) -> Value {
    json!({"type":"channel_activity","channel_id":channel,"seq":seq})
}

#[sqlx::test]
async fn activity_ready_is_the_first_event_after_registration(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    assert_eq!(
        raw_event(&mut socket).await,
        json!({"type":"activity_ready"})
    );
    assert_eq!(raw_event(&mut socket).await["type"], "subscribed");
}
#[sqlx::test]
async fn own_sends_emit_no_channel_activity_to_the_sender_but_reach_other_members(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, other) = member(&pool, f.organization).await;
    let second = session::another_session(&pool, f.organization, f.member).await;
    let mut sender = connect(&f, &f.token).await;
    let mut own_other = connect(&f, &second).await;
    let mut reader = connect(&f, &other).await;
    post(&f, f.channel).await;
    assert_eq!(notices(&f, &mut reader).await, vec![activity(f.channel, 1)]);
    assert!(notices(&f, &mut sender).await.is_empty());
    assert!(notices(&f, &mut own_other).await.is_empty());
}
#[sqlx::test]
async fn private_channel_activity_skips_non_members(pool: PgPool) {
    let f = fixture(&pool).await;
    let (reader, token) = member(&pool, f.organization).await;
    let (_, denied) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, reader).await;
    let mut allowed = connect(&f, &token).await;
    let mut denied = connect(&f, &denied).await;
    post(&f, private).await;
    assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 1)]);
    assert!(notices(&f, &mut denied).await.is_empty());
}
#[sqlx::test]
async fn guest_without_grant_receives_no_public_channel_activity_or_creation(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (guest, denied) = member(&pool, f.organization).await;
    let (grantee, allowed) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    role(&pool, &f, grantee, "guest").await;
    grant(&pool, &f, f.channel, grantee).await;
    let (_, ordinary) = member(&pool, f.organization).await;
    let mut denied = connect(&f, &denied).await;
    let mut allowed = connect(&f, &allowed).await;
    let mut ordinary = connect(&f, &ordinary).await;
    post(&f, f.channel).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
    assert_eq!(
        notices(&f, &mut ordinary).await,
        vec![activity(f.channel, 1)]
    );
    assert!(notices(&f, &mut denied).await.is_empty());
    let response = request(
        &f.app,
        "POST",
        "/api/v1/channels",
        &f.token,
        json!({"name":"new-public","visibility":"public"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(notices(&f, &mut denied).await.is_empty());
    assert!(notices(&f, &mut allowed).await.is_empty());
    assert_eq!(
        notices(&f, &mut ordinary).await[0]["type"],
        "channel_access_gained"
    );
}
#[sqlx::test]
async fn other_organization_socket_of_same_account_receives_nothing(pool: PgPool) {
    let f = fixture(&pool).await;
    let foreign = organization(&pool).await;
    sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) SELECT $1,$2,account_id,'Other','member' FROM users WHERE organization_id=$3 AND id=$4")
        .bind(foreign).bind(Uuid::new_v4()).bind(f.organization).bind(f.member).execute(&pool).await.unwrap();
    let foreign_token = f.token.clone();
    let mut request = format!("ws://{}/api/v1/orgs/{foreign}/ws", f.server.address)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {foreign_token}").parse().unwrap(),
    );
    let mut denied = tokio_tungstenite::connect_async(request).await.unwrap().0;
    assert_eq!(raw_event(&mut denied).await["type"], "activity_ready");
    let (_, reader) = member(&pool, f.organization).await;
    let mut allowed = connect(&f, &reader).await;
    post(&f, f.channel).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
    assert!(notices(&f, &mut denied).await.is_empty());
}
#[sqlx::test]
async fn revoked_grant_receives_revocation_then_no_activity(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let (control, other) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, target).await;
    grant(&pool, &f, private, control).await;
    let mut denied = connect(&f, &token).await;
    let mut allowed = connect(&f, &other).await;
    let r = request(
        &f.app,
        "DELETE",
        &format!("/api/v1/channels/{private}/members/{target}"),
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    let removed = notices(&f, &mut denied).await;
    assert!(
        removed.contains(&json!({"type":"channel_access_revoked","channel_id":private})),
        "{removed:?}"
    );
    notices(&f, &mut allowed).await;
    post(&f, private).await;
    assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 1)]);
    assert!(notices(&f, &mut denied).await.is_empty());
}
#[sqlx::test]
async fn role_to_guest_revokes_public_channels_without_grant_and_keeps_granted_ones(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let granted = channel(&pool, f.organization, f.member, false).await;
    grant(&pool, &f, granted, target).await;
    let (_, other) = member(&pool, f.organization).await;
    let mut denied = connect(&f, &token).await;
    let mut allowed = connect(&f, &other).await;
    let r = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/orgs/{}/members/{target}/role", f.organization),
        &f.token,
        json!({"role":"guest"}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    let changed = notices(&f, &mut denied).await;
    assert!(
        changed.contains(&json!({"type":"channel_access_revoked","channel_id":f.channel})),
        "{changed:?}"
    );
    assert!(!changed.contains(&json!({"type":"channel_access_revoked","channel_id":granted})));
    notices(&f, &mut allowed).await;
    post(&f, f.channel).await;
    post(&f, granted).await;
    assert_eq!(notices(&f, &mut denied).await, vec![activity(granted, 1)]);
    assert_eq!(notices(&f, &mut allowed).await.len(), 2);
}
#[sqlx::test]
async fn stale_membership_revision_socket_matches_no_recipient(pool: PgPool) {
    let f = fixture(&pool).await;
    let (target, token) = member(&pool, f.organization).await;
    let (_, control) = member(&pool, f.organization).await;
    let mut stale = connect(&f, &token).await;
    let mut allowed = connect(&f, &control).await;
    sqlx::query(
        "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
    )
    .bind(f.organization)
    .bind(target)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    post(&f, f.channel).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
    assert!(notices(&f, &mut stale).await.is_empty());
}
#[sqlx::test]
async fn ended_session_closes_4001_and_receives_no_notice(pool: PgPool) {
    let f = fixture(&pool).await;
    let (target, token) = member(&pool, f.organization).await;
    let other = session::another_session(&pool, f.organization, target).await;
    let mut denied = connect(&f, &token).await;
    let mut allowed = connect(&f, &other).await;
    let response = request(&f.app, "DELETE", "/api/v1/session", &token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    post(&f, f.channel).await;
    raw_closed(&mut denied, 4001).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
}
#[sqlx::test]
async fn deactivated_member_closes_4003_and_receives_no_notice(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let (_, control) = member(&pool, f.organization).await;
    let mut denied = connect(&f, &token).await;
    let mut allowed = connect(&f, &control).await;
    let response = request(
        &f.app,
        "POST",
        &format!(
            "/api/v1/orgs/{}/members/{target}/deactivate",
            f.organization
        ),
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    raw_closed(&mut denied, 4003).await;
    notices(&f, &mut allowed).await;
    post(&f, f.channel).await;
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![activity(f.channel, 1)]
    );
}
#[sqlx::test]
async fn two_senders_coalesce_without_losing_each_others_activity(pool: PgPool) {
    for reverse in [false, true] {
        let f = fixture(&pool).await;
        let (bob, bob_token) = member(&pool, f.organization).await;
        let (third_id, third_token) = member(&pool, f.organization).await;
        let (_, denied_token) = member(&pool, f.organization).await;
        let private = channel(&pool, f.organization, f.member, true).await;
        grant(&pool, &f, private, bob).await;
        grant(&pool, &f, private, third_id).await;
        let alice_other = session::another_session(&pool, f.organization, f.member).await;
        let bob_other = session::another_session(&pool, f.organization, bob).await;
        let mut alice = connect(&f, &f.token).await;
        let mut alice2 = connect(&f, &alice_other).await;
        let mut bob1 = connect(&f, &bob_token).await;
        let mut bob2 = connect(&f, &bob_other).await;
        let mut third = connect(&f, &third_token).await;
        let mut denied = connect(&f, &denied_token).await;
        let (first, second) = if reverse {
            (&bob_token, &f.token)
        } else {
            (&f.token, &bob_token)
        };
        let gate = crate::channels::activity::pause(f.organization, private, "authorized");
        send(&f, first, private, Uuid::new_v4(), "First").await;
        tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        send(&f, second, private, Uuid::new_v4(), "Second").await;
        gate.release.add_permits(1);
        for socket in [&mut alice, &mut alice2] {
            assert_eq!(
                notices(&f, socket).await,
                vec![activity(private, if reverse { 1 } else { 2 })]
            );
        }
        for socket in [&mut bob1, &mut bob2] {
            assert_eq!(
                notices(&f, socket).await,
                vec![activity(private, if reverse { 2 } else { 1 })]
            );
        }
        assert_eq!(
            notices(&f, &mut third).await.last(),
            Some(&activity(private, 2))
        );
        assert!(notices(&f, &mut denied).await.is_empty());
    }
}
#[sqlx::test]
async fn more_than_256_visible_channels_receive_unwatched_activity_without_message_bodies(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (_, reader) = member(&pool, f.organization).await;
    let mut last = f.channel;
    for _ in 0..257 {
        last = channel(&pool, f.organization, f.member, false).await;
    }
    let mut socket = connect(&f, &reader).await;
    subscribe(&mut socket, f.channel, 0).await;
    assert_eq!(raw_event(&mut socket).await["type"], "subscribed");
    post(&f, last).await;
    assert_eq!(notices(&f, &mut socket).await, vec![activity(last, 1)]);
}
#[sqlx::test]
async fn topic_mark_read_notifies_with_topic_id_and_channel_mark_read_with_null(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, sender) = member(&pool, f.organization).await;
    send(&f, &sender, f.channel, Uuid::new_v4(), "Unread").await;
    let response = request(&f.app, "POST", &format!("/api/v1/channels/{}/messages", f.channel), &sender,
        json!({"client_message_id":Uuid::new_v4(),"body":"Topic unread","topic_name":"Activity topic"})).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let message: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    let topic = message["topic_id"].as_str().unwrap();
    let second = session::another_session(&pool, f.organization, f.member).await;
    let mut same = connect(&f, &second).await;
    let mut other = connect(&f, &sender).await;
    let response = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{}/topics/{topic}/read", f.channel),
        &f.token,
        json!({"read_seq":2}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        notices(&f, &mut same).await,
        vec![
            json!({"type":"read_position_changed","channel_id":f.channel,"topic_id":topic,"read_seq":2})
        ]
    );
    assert!(notices(&f, &mut other).await.is_empty());
    let response = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{}/read", f.channel),
        &f.token,
        json!({"read_seq":1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        notices(&f, &mut same).await,
        vec![
            json!({"type":"read_position_changed","channel_id":f.channel,"topic_id":null,"read_seq":1})
        ]
    );
    assert!(notices(&f, &mut other).await.is_empty());
    let response = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{}/read", f.channel),
        &f.token,
        json!({"read_seq":1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(notices(&f, &mut same).await.is_empty());
}

#[sqlx::test]
async fn paused_query_then_observed_revoke_regrant_rejects_late_publication(pool: PgPool) {
    for phase in ["query", "authorized", "handoff"] {
        let f = fixture(&pool).await;
        owner(&pool, &f).await;
        let (target, token) = member(&pool, f.organization).await;
        let (control, other) = member(&pool, f.organization).await;
        let private = channel(&pool, f.organization, f.member, true).await;
        grant(&pool, &f, private, target).await;
        grant(&pool, &f, private, control).await;
        let mut denied = connect(&f, &token).await;
        let mut allowed = connect(&f, &other).await;
        let gate = crate::channels::activity::pause_member(
            f.organization,
            private,
            phase,
            if phase == "handoff" {
                Some(target)
            } else {
                None
            },
        );
        post(&f, private).await;
        tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        let remove = request(
            &f.app,
            "DELETE",
            &format!("/api/v1/channels/{private}/members/{target}"),
            &f.token,
            Value::Null,
        )
        .await;
        assert_eq!(remove.status(), StatusCode::NO_CONTENT);
        let add = request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{private}/members"),
            &f.token,
            json!({"member_id":target}),
        )
        .await;
        assert_eq!(add.status(), StatusCode::NO_CONTENT);
        gate.release.add_permits(1);
        let before = notices(&f, &mut denied).await;
        assert!(
            !before.contains(&activity(private, 1)),
            "phase={phase}: {before:?}"
        );
        let control = notices(&f, &mut allowed).await;
        assert!(control.contains(&activity(private, 1)), "{control:?}");
        post(&f, private).await;
        assert!(
            notices(&f, &mut denied)
                .await
                .contains(&activity(private, 2))
        );
    }
}
#[sqlx::test]
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
    gate.entered.acquire().await.unwrap().forget();
    assert!(notices(&f, &mut reader).await.is_empty());
    gate.release.add_permits(1);
    assert_eq!(task.await.unwrap().status(), StatusCode::CREATED);
    assert_eq!(notices(&f, &mut reader).await, vec![activity(f.channel, 1)]);
}
#[sqlx::test]
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
#[sqlx::test]
async fn public_channel_creation_notifies_non_guests_and_private_creation_only_the_creator(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (_, other) = member(&pool, f.organization).await;
    let mut creator = connect(&f, &f.token).await;
    let mut reader = connect(&f, &other).await;
    for visibility in ["public", "private"] {
        let response = request(
            &f.app,
            "POST",
            "/api/v1/channels",
            &f.token,
            json!({"name":visibility,"visibility":visibility}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
        let expected = json!({"type":"channel_access_gained","channel_id":body["id"]});
        assert_eq!(notices(&f, &mut creator).await, vec![expected.clone()]);
        assert_eq!(
            notices(&f, &mut reader).await,
            if visibility == "public" {
                vec![expected]
            } else {
                vec![]
            }
        );
    }
}
#[sqlx::test]
async fn guest_last_shared_channel_removal_invalidates_own_directory(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (guest, token) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    grant(&pool, &f, f.channel, guest).await;
    let (outside, outside_token) = member(&pool, f.organization).await;
    role(&pool, &f, outside, "guest").await;
    let mut own = connect(&f, &token).await;
    let mut invisible = connect(&f, &outside_token).await;
    let response = request(
        &f.app,
        "DELETE",
        &format!("/api/v1/channels/{}/members/{guest}", f.channel),
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let events = notices(&f, &mut own).await;
    assert!(
        events.contains(&json!({"type":"members_changed"})),
        "{events:?}"
    );
    assert!(events.contains(&json!({"type":"channel_access_revoked","channel_id":f.channel})));
    assert!(notices(&f, &mut invisible).await.is_empty());
}

#[sqlx::test]
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
            tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
                .await
                .unwrap()
                .unwrap()
                .forget();
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
#[sqlx::test]
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

async fn batch_measurement(pool: &PgPool, readers: usize) -> Value {
    let f = fixture(pool).await;
    let (bob, bob_token) = member(pool, f.organization).await;
    let (_, reader_token) = member(pool, f.organization).await;
    let alice_other = session::another_session(pool, f.organization, f.member).await;
    let bob_other = session::another_session(pool, f.organization, bob).await;
    let mut sockets = Vec::new();
    for token in [&f.token, &alice_other, &bob_token, &bob_other] {
        sockets.push((
            connect(&f, token).await,
            if token == &f.token || token == &alice_other {
                4
            } else {
                3
            },
        ));
    }
    for _ in 0..readers {
        sockets.push((connect(&f, &reader_token).await, 4));
    }
    let gate = crate::channels::activity::pause(f.organization, f.channel, "authorized");
    post(&f, f.channel).await;
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    send(&f, &bob_token, f.channel, Uuid::new_v4(), "Bob 2").await;
    post(&f, f.channel).await;
    send(&f, &bob_token, f.channel, Uuid::new_v4(), "Bob 4").await;
    let start = std::time::Instant::now();
    gate.release.add_permits(1);
    let mut tasks = tokio::task::JoinSet::new();
    for (mut socket, expected) in sockets {
        tasks.spawn(async move {
            loop {
                let event = raw_event(&mut socket).await;
                assert_eq!(event["type"], "channel_activity");
                assert_eq!(event["channel_id"], f.channel.to_string());
                if event["seq"] == expected {
                    return start.elapsed().as_micros() as u64;
                }
            }
        });
    }
    let mut micros = Vec::new();
    while let Some(result) = tasks.join_next().await {
        micros.push(result.unwrap());
    }
    f.state
        .message_delivery
        .channel_access
        .activity
        .drained()
        .await;
    let queries = f
        .state
        .message_delivery
        .channel_access
        .activity
        .queries
        .load(std::sync::atomic::Ordering::SeqCst);
    assert_eq!(queries, 2, "one frozen query and one pending batch");
    micros.sort_unstable();
    let at = |p: usize| micros[(micros.len() * p).div_ceil(100) - 1];
    json!({"reader_sockets":readers,"sender_sockets":4,"committed_sends":4,"recipient_queries":queries,"release_to_final_notice_us":{"p50":at(50),"p95":at(95),"p99":at(99),"max":micros.last()},"app_pool_max":f.state.pool.options().get_max_connections()})
}
#[sqlx::test]
async fn messages_after_authorization_snapshot_get_a_fresh_batch(pool: PgPool) {
    batch_measurement(&pool, 1).await;
}
#[sqlx::test]
#[ignore = "manual release multi-sender coalescing measurement, separate from periodic REST load"]
async fn measure_multi_sender_activity_batching(pool: PgPool) {
    eprintln!(
        "ACTIVITY_BATCH_MEASUREMENT {}",
        batch_measurement(&pool, 1000).await
    );
}

async fn raw_closed(socket: &mut Client, code: u16) {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        {
            tungstenite::Message::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), code);
                return;
            }
            tungstenite::Message::Ping(_) => socket.flush().await.unwrap(),
            frame => panic!("denied socket received protected data before close: {frame:?}"),
        }
    }
}
#[sqlx::test]
async fn mark_read_on_one_session_notifies_every_session_of_that_member_only(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, sender) = member(&pool, f.organization).await;
    send(&f, &sender, f.channel, Uuid::new_v4(), "Unread").await;
    let second = session::another_session(&pool, f.organization, f.member).await;
    let mut sockets = vec![
        connect(&f, &f.token).await,
        connect(&f, &f.token).await,
        connect(&f, &second).await,
    ];
    let mut denied = connect(&f, &sender).await;
    let response = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{}/read", f.channel),
        &f.token,
        json!({"read_seq":1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    for socket in &mut sockets {
        assert_eq!(
            notices(&f, socket).await,
            vec![
                json!({"type":"read_position_changed","channel_id":f.channel,"topic_id":null,"read_seq":1})
            ]
        );
    }
    assert!(notices(&f, &mut denied).await.is_empty());
}
#[sqlx::test]
async fn grant_notifies_target_gain_and_channel_viewers_members_changed(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let (_, outside) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let mut own = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    let mut denied = connect(&f, &outside).await;
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{private}/members"),
        &f.token,
        json!({"member_id":target}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let events = notices(&f, &mut own).await;
    assert!(
        events.contains(&json!({"type":"channel_access_gained","channel_id":private})),
        "{events:?}"
    );
    assert!(events.contains(&json!({"type":"channel_members_changed","channel_id":private})));
    assert_eq!(
        notices(&f, &mut control).await,
        vec![json!({"type":"channel_members_changed","channel_id":private})]
    );
    assert!(notices(&f, &mut denied).await.is_empty());
}
#[sqlx::test]
async fn manager_right_change_notifies_target_list_and_channel_viewers(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let (_, outside) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, target).await;
    let mut own = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    let mut denied = connect(&f, &outside).await;
    let response = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/channels/{private}/members/{target}"),
        &f.token,
        json!({"manager":true}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let events = notices(&f, &mut own).await;
    assert!(events.contains(&json!({"type":"channel_list_changed"})));
    assert!(events.contains(&json!({"type":"channel_members_changed","channel_id":private})));
    assert_eq!(
        notices(&f, &mut control).await,
        vec![json!({"type":"channel_members_changed","channel_id":private})]
    );
    assert!(notices(&f, &mut denied).await.is_empty());
    let response = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/channels/{private}/members/{target}"),
        &f.token,
        json!({"manager":true}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(notices(&f, &mut own).await.is_empty());
    assert!(notices(&f, &mut control).await.is_empty());
}
#[sqlx::test]
async fn promotion_from_guest_notifies_gained_public_channels(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    role(&pool, &f, target, "guest").await;
    let (outside, outside_token) = member(&pool, f.organization).await;
    role(&pool, &f, outside, "guest").await;
    let mut own = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    let mut denied = connect(&f, &outside_token).await;
    let response = request(
        &f.app,
        "PATCH",
        &format!("/api/v1/orgs/{}/members/{target}/role", f.organization),
        &f.token,
        json!({"role":"member"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        notices(&f, &mut own)
            .await
            .contains(&json!({"type":"channel_access_gained","channel_id":f.channel}))
    );
    assert!(
        notices(&f, &mut control)
            .await
            .contains(&json!({"type":"members_changed"}))
    );
    assert!(notices(&f, &mut denied).await.is_empty());
}
#[sqlx::test]
async fn invite_acceptance_notifies_members_changed_to_non_guests_only(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (guest, token) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    let mut denied = connect(&f, &token).await;
    let mut allowed = connect(&f, &f.token).await;
    let email = format!("{}@example.invalid", Uuid::new_v4());
    let response = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/invites", f.organization),
        &f.token,
        json!({"email":email,"role":"member"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let invite: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    assert!(notices(&f, &mut allowed).await.is_empty());
    let response=f.app.clone().oneshot(Request::post(format!("/api/v1/orgs/{}/invites/accept",f.organization)).header(header::CONTENT_TYPE,"application/json").body(Body::from(json!({"email":email,"name":"New Member","password":"invite password 307","token":invite["token"]}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        notices(&f, &mut allowed).await,
        vec![json!({"type":"members_changed"})]
    );
    assert!(notices(&f, &mut denied).await.is_empty());
}

mod process;

#[sqlx::test]
async fn revocation_reaches_only_the_current_target_of_removed_access(pool: PgPool) {
    for public in [false, true] {
        let f = fixture(&pool).await;
        owner(&pool, &f).await;
        let (target, token) = member(&pool, f.organization).await;
        if public {
            role(&pool, &f, target, "guest").await;
        }
        let (control, control_token) = member(&pool, f.organization).await;
        let (_, outside_token) = member(&pool, f.organization).await;
        let (guest, guest_token) = member(&pool, f.organization).await;
        role(&pool, &f, guest, "guest").await;
        let channel = channel(&pool, f.organization, f.member, !public).await;
        grant(&pool, &f, channel, target).await;
        grant(&pool, &f, channel, control).await;
        let mut own = connect(&f, &token).await;
        let mut allowed = connect(&f, &control_token).await;
        let mut outside = connect(&f, &outside_token).await;
        let mut ungranted = connect(&f, &guest_token).await;
        let ended = session::another_session(&pool, f.organization, target).await;
        let mut ended_socket = connect(&f, &ended).await;
        let response = request(&f.app, "DELETE", "/api/v1/session", &ended, Value::Null).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        raw_closed(&mut ended_socket, 4001).await;
        // A lost deactivation/reactivation signal leaves this old registration live but ineligible.
        sqlx::query(
            "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        )
        .bind(f.organization)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(f.organization)
            .bind(target)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE channel_members SET membership_revision=(SELECT membership_revision FROM users WHERE organization_id=$1 AND id=$2) WHERE organization_id=$1 AND channel_id=$3 AND member_id=$2")
            .bind(f.organization).bind(target).bind(channel).execute(&pool).await.unwrap();
        let mut current = connect(&f, &token).await;
        let response = request(
            &f.app,
            "DELETE",
            &format!("/api/v1/channels/{channel}/members/{target}"),
            &f.token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let changed = notices(&f, &mut current).await;
        assert!(
            changed.contains(&json!({"type":"channel_access_revoked","channel_id":channel})),
            "{changed:?}"
        );
        raw_closed(&mut own, 4003).await;
        assert_eq!(
            notices(&f, &mut allowed).await,
            vec![json!({"type":"channel_members_changed","channel_id":channel})]
        );
        let other = notices(&f, &mut outside).await;
        assert!(
            !other
                .iter()
                .any(|event| event["type"] == "channel_access_revoked")
        );
        if !public {
            assert!(other.is_empty());
        }
        assert!(notices(&f, &mut ungranted).await.is_empty());
    }
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    grant(&pool, &f, f.channel, target).await;
    let mut own = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    assert_eq!(
        request(
            &f.app,
            "DELETE",
            &format!("/api/v1/channels/{}/members/{target}", f.channel),
            &f.token,
            Value::Null
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let changed = notices(&f, &mut own).await;
    assert!(changed.contains(&json!({"type":"channel_list_changed"})));
    assert!(
        !changed
            .iter()
            .any(|event| event["type"] == "channel_access_revoked")
    );
    assert_eq!(
        notices(&f, &mut control).await,
        vec![json!({"type":"channel_members_changed","channel_id":f.channel})]
    );
}

#[sqlx::test]
async fn durable_grant_comparison_retires_buffered_activity_after_lost_fast_signals(pool: PgPool) {
    let f = fixture(&pool).await;
    let (target, token) = member(&pool, f.organization).await;
    let (control, control_token) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, target).await;
    grant(&pool, &f, private, control).await;
    let mut own = connect(&f, &token).await;
    let mut allowed = connect(&f, &control_token).await;
    post(&f, private).await;
    assert_eq!(notices(&f, &mut own).await, vec![activity(private, 1)]);
    notices(&f, &mut allowed).await;
    let gate =
        crate::channels::activity::pause_member(f.organization, private, "handoff", Some(target));
    post(&f, private).await;
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(f.organization)
    .bind(private)
    .bind(target)
    .execute(&pool)
    .await
    .unwrap();
    grant(&pool, &f, private, target).await;
    f.state
        .message_delivery
        .channel_access
        .activity
        .check(
            &f.state.pool,
            crate::auth::SubscriptionScope::Member(f.organization, target),
        )
        .await;
    gate.release.add_permits(1);
    assert!(notices(&f, &mut own).await.is_empty());
    assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 2)]);
    post(&f, private).await;
    assert_eq!(notices(&f, &mut own).await, vec![activity(private, 3)]);
    assert_eq!(notices(&f, &mut allowed).await, vec![activity(private, 3)]);
}

#[sqlx::test]
async fn role_change_and_deactivation_notify_members_changed_per_directory_rule(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, _) = member(&pool, f.organization).await;
    let (guest, guest_token) = member(&pool, f.organization).await;
    role(&pool, &f, guest, "guest").await;
    let mut invisible = connect(&f, &guest_token).await;
    let mut control = connect(&f, &f.token).await;
    for (method, suffix, body) in [
        ("PATCH", "role", json!({"role":"admin"})),
        ("POST", "deactivate", Value::Null),
    ] {
        let response = request(
            &f.app,
            method,
            &format!("/api/v1/orgs/{}/members/{target}/{suffix}", f.organization),
            &f.token,
            body,
        )
        .await;
        assert!(response.status().is_success());
        assert!(
            notices(&f, &mut control)
                .await
                .contains(&json!({"type":"members_changed"}))
        );
        // Until #294, only self-change directory notices are permitted for Guests.
        assert!(notices(&f, &mut invisible).await.is_empty());
    }
}

#[sqlx::test]
async fn regrant_rejects_a_paused_old_revocation_before_enqueue_and_handoff(pool: PgPool) {
    for phase in ["revoked", "handoff"] {
        let f = fixture(&pool).await;
        owner(&pool, &f).await;
        let (target, token) = member(&pool, f.organization).await;
        let private = channel(&pool, f.organization, f.member, true).await;
        grant(&pool, &f, private, target).await;
        let mut own = connect(&f, &token).await;
        let mut control = connect(&f, &f.token).await;
        let gate =
            crate::channels::activity::pause_member(f.organization, private, phase, Some(target));
        let response = request(
            &f.app,
            "DELETE",
            &format!("/api/v1/channels/{private}/members/{target}"),
            &f.token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        let response = request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{private}/members"),
            &f.token,
            json!({"member_id":target}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        gate.release.add_permits(1);
        let changed = notices(&f, &mut own).await;
        assert!(
            !changed
                .iter()
                .any(|event| event["type"] == "channel_access_revoked"),
            "{phase}: {changed:?}"
        );
        assert!(
            changed.contains(&json!({"type":"channel_access_gained","channel_id":private})),
            "{phase}: {changed:?}"
        );
        assert!(
            notices(&f, &mut control)
                .await
                .contains(&json!({"type":"channel_members_changed","channel_id":private}))
        );
        post(&f, private).await;
        assert_eq!(notices(&f, &mut own).await, vec![activity(private, 1)]);
    }
}

#[sqlx::test]
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
            tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
                .await
                .unwrap()
                .unwrap()
                .forget();
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
