use super::*;

#[fukulow_test::test]
async fn delete_grant_reports_revocation_with_and_without_an_active_subscription(pool: PgPool) {
    use crate::auth::{SubscriptionRecheck, SubscriptionScope};
    use crate::channels::activity::pause_member;

    struct RecheckBeforePublication {
        access: crate::channels::AccessChanges,
        // Not an array: the module-direction driver ICEs on array lengths in local items.
        gates: Vec<Arc<Gate>>,
    }
    impl SubscriptionRecheck for RecheckBeforePublication {
        fn check<'a>(
            &'a self,
            pool: &'a PgPool,
            scope: SubscriptionScope,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>>
        {
            Box::pin(async move {
                let result = self.access.check(pool, scope).await;
                for gate in &self.gates {
                    gate.release();
                }
                result
            })
        }
        fn failed(&self, scope: SubscriptionScope) {
            self.access.failed(scope);
        }
    }

    async fn frames(f: &Fixture, socket: &mut Client) -> Vec<Value> {
        f.state
            .message_delivery
            .channel_access
            .activity
            .drained()
            .await;
        let nonce = Uuid::new_v4().as_bytes().to_vec();
        // Both observed access loss and the drained notice buffer precede recv/Pong.
        socket
            .send(tungstenite::Message::Ping(nonce.clone().into()))
            .await
            .unwrap();
        let mut result = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(5), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
            {
                tungstenite::Message::Pong(bytes) if bytes.as_ref() == nonce => return result,
                tungstenite::Message::Ping(_) => socket.flush().await.unwrap(),
                tungstenite::Message::Text(text) => {
                    result.push(serde_json::from_str(&text).unwrap())
                }
                other => panic!("unexpected frame: {other:?}"),
            }
        }
    }

    let mut cases = Vec::new();
    for subscribed in [true, false] {
        let f = fixture(&pool).await;
        owner(&pool, &f).await;
        let (target, token) = member(&pool, f.organization).await;
        let private = channel(&pool, f.organization, f.member, true).await;
        grant(&pool, &f, private, target).await;
        let mut socket = connect(&f, &token).await;
        if subscribed {
            subscribe(&mut socket, private, 0).await;
            let reply = raw_event(&mut socket).await;
            assert_eq!(reply["type"], "subscribed");
            assert_eq!(reply["channel_id"], json!(private));
            assert_eq!(reply["caught_up_seq"], 0);
        }
        // Main starts the publisher first; this gate forces its after-state query
        // to follow the completed recheck under either mutation ordering.
        let gate = pause_member(f.organization, Uuid::nil(), "target_state", Some(target));
        // Keep main's concurrent member-list publisher before Authorization::new,
        // so it cannot contribute an unrelated unproved query to the recheck.
        let member_gate = pause_member(f.organization, private, "snapshot", None);
        // Hold the target's list handoff so its two directory publications
        // coalesce before collection, independent of socket scheduling.
        let handoff = pause_member(f.organization, Uuid::nil(), "handoff", Some(target));
        f.state
            .session_changes
            .set_subscription_recheck(Arc::new(RecheckBeforePublication {
                access: f.state.message_delivery.channel_access.clone(),
                gates: vec![gate.clone(), member_gate],
            }));
        let response = request(
            &f.app,
            "DELETE",
            &format!("/api/v1/channels/{private}/members/{target}"),
            &f.token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        gate.entered().await;
        f.state
            .message_delivery
            .channel_access
            .activity
            .drained()
            .await;
        handoff.release();
        let received = frames(&f, &mut socket).await;
        eprintln!("subscribed={subscribed}: {received:?}");
        let mut expected = vec![
            json!({"type":"channel_access_revoked","channel_id":private}),
            json!({"type":"channel_list_changed"}),
            json!({"type":"members_changed"}),
        ];
        if subscribed {
            expected.push(json!({"type":"channel_access_lost","channel_id":private}));
        }
        // A7 promises no ordering between the two event streams or different keys.
        let mut received = received;
        received.sort_by_key(Value::to_string);
        expected.sort_by_key(Value::to_string);
        cases.push((subscribed, received, expected));
    }
    for (subscribed, received, expected) in cases {
        assert_eq!(received, expected, "subscribed={subscribed}");
    }
}
#[fukulow_test::test]
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
#[fukulow_test::test]
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

#[fukulow_test::test]
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
        let allowed_events = notices(&f, &mut allowed).await;
        assert!(
            allowed_events
                .contains(&json!({"type":"channel_members_changed","channel_id":channel}))
        );
        assert!(allowed_events.contains(&json!({"type":"members_changed"})));
        let other = notices(&f, &mut outside).await;
        assert!(
            !other
                .iter()
                .any(|event| event["type"] == "channel_access_revoked")
        );
        assert!(other.contains(&json!({"type":"members_changed"})));
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
    let control_events = notices(&f, &mut control).await;
    assert!(
        control_events.contains(&json!({"type":"channel_members_changed","channel_id":f.channel}))
    );
    assert!(control_events.contains(&json!({"type":"members_changed"})));
}

#[fukulow_test::test]
async fn regrant_rejects_a_paused_old_revocation_before_enqueue_and_handoff(pool: PgPool) {
    for phase in ["snapshot", "revoked", "handoff"] {
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
        gate.entered().await;
        let response = request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{private}/members"),
            &f.token,
            json!({"member_id":target}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let mut gained = Vec::new();
        if phase == "snapshot" {
            loop {
                let event = raw_event(&mut own).await;
                let ready = event["type"] == "channel_access_gained";
                gained.push(event);
                if ready {
                    break;
                }
            }
        }
        gate.release();
        let mut changed = gained;
        changed.extend(notices(&f, &mut own).await);
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
        let control_notices = notices(&f, &mut control).await;
        assert!(
            control_notices
                .contains(&json!({"type":"channel_members_changed","channel_id":private})),
            "phase={phase}: control notices={control_notices:?}"
        );
        post(&f, private).await;
        assert_eq!(notices(&f, &mut own).await, vec![activity(private, 1)]);
    }
}

#[fukulow_test::test]
async fn socket_registered_after_access_removal_receives_no_old_revocation(pool: PgPool) {
    use crate::auth::activity::{
        ActivityChange, ActivityChanges, Capture, ChangeScope, ChannelChange,
    };
    struct DelayedChanges {
        activity: crate::channels::activity::Activity,
        gate: Arc<Gate>,
    }
    struct DelayedChange {
        change: Box<dyn ActivityChange>,
        gate: Arc<Gate>,
    }
    impl ActivityChanges for DelayedChanges {
        fn channel(&self, pool: PgPool, organization: Uuid, change: ChannelChange) {
            self.activity.channel(pool, organization, change);
        }
        fn capture<'a>(
            &'a self,
            tx: &'a mut sqlx::PgConnection,
            organization: Uuid,
            target: Uuid,
            scope: ChangeScope,
        ) -> Capture<'a> {
            Box::pin(async move {
                Ok(Box::new(DelayedChange {
                    change: self
                        .activity
                        .capture(tx, organization, target, scope)
                        .await?,
                    gate: self.gate.clone(),
                }) as Box<dyn ActivityChange>)
            })
        }
        fn directory(&self, pool: PgPool, organization: Uuid, target: Uuid) {
            self.activity.directory(pool, organization, target);
        }
    }
    impl ActivityChange for DelayedChange {
        fn retire(&mut self) {
            self.change.retire();
        }
        fn committed(self: Box<Self>, pool: PgPool) {
            tokio::spawn(async move {
                self.gate.pause().await;
                self.change.committed(pool);
            });
        }
    }
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (target, token) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    grant(&pool, &f, private, target).await;
    let mut before = connect(&f, &token).await;
    let mut control = connect(&f, &f.token).await;
    let delayed = Arc::new(Gate::default());
    f.state
        .session_changes
        .set_activity(std::sync::Arc::new(DelayedChanges {
            activity: f.state.message_delivery.channel_access.activity.clone(),
            gate: delayed.clone(),
        }));
    let response = request(
        &f.app,
        "DELETE",
        &format!("/api/v1/channels/{private}/members/{target}"),
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    delayed.entered().await;
    let mut after = connect(&f, &token).await;
    let gate =
        crate::channels::activity::pause_member(f.organization, private, "snapshot", Some(target));
    delayed.release();
    gate.entered().await;
    gate.release();

    assert!(
        notices(&f, &mut before)
            .await
            .contains(&json!({"type":"channel_access_revoked","channel_id":private}))
    );
    assert!(
        !notices(&f, &mut after)
            .await
            .iter()
            .any(|event| event["type"] == "channel_access_revoked")
    );
    assert!(
        notices(&f, &mut control)
            .await
            .contains(&json!({"type":"channel_members_changed","channel_id":private}))
    );
}
