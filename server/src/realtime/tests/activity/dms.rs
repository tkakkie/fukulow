use super::*;
use crate::channels::{activity::Notice, tests::extract_auth};

async fn open_dm(f: &Fixture, token: &str, peer: Uuid, renew: bool) -> Response {
    request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/dms", f.organization),
        token,
        json!({"member_id":peer,"renew":renew}),
    )
    .await
}
fn changed() -> Value {
    json!({"type":"dm_list_changed"})
}
fn gained(channel: Uuid) -> Value {
    json!({"type":"channel_access_gained","channel_id":channel})
}

#[fukulow_test::test]
async fn dm_notices_reach_both_participants_and_only_other_senders_and_own_read_sessions(
    pool: PgPool,
) {
    for peer_role in ["member", "guest"] {
        let f = fixture(&pool).await;
        let (peer, peer_token) = member(&pool, f.organization).await;
        role(&pool, &f, peer, peer_role).await;
        let own_token = session::another_session(&pool, f.organization, f.member).await;
        let other_peer_token = session::another_session(&pool, f.organization, peer).await;
        let mut own = connect(&f, &f.token).await;
        let mut own_second = connect(&f, &own_token).await;
        let mut other = connect(&f, &peer_token).await;
        let mut other_second = connect(&f, &other_peer_token).await;
        let response = open_dm(&f, &f.token, peer, false).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let channel = Uuid::parse_str(body(response).await["id"].as_str().unwrap()).unwrap();
        for socket in [&mut own, &mut own_second, &mut other, &mut other_second] {
            let events = notices(&f, socket).await;
            assert!(events.contains(&changed()), "{events:?}");
            assert!(events.contains(&gained(channel)), "{events:?}");
            assert!(
                !events.iter().any(|e| e["type"] == "channel_members_changed"
                    || e["type"] == "channel_list_changed")
            );
        }
        for renew in [false, true] {
            assert_eq!(
                open_dm(&f, &f.token, peer, renew).await.status(),
                StatusCode::OK
            );
            for socket in [&mut own, &mut own_second, &mut other, &mut other_second] {
                assert!(notices(&f, socket).await.is_empty());
            }
        }
        let key = Uuid::new_v4();
        send(&f, &f.token, channel, key, "DM activity").await;
        for socket in [&mut other, &mut other_second] {
            assert_eq!(notices(&f, socket).await, vec![activity(channel, 1)]);
        }
        for socket in [&mut own, &mut own_second] {
            assert!(notices(&f, socket).await.is_empty());
        }
        send(&f, &f.token, channel, key, "DM activity").await;
        for socket in [&mut own, &mut own_second, &mut other, &mut other_second] {
            assert!(notices(&f, socket).await.is_empty());
        }
        for attempt in 0..2 {
            let r = request(
                &f.app,
                "PUT",
                &format!("/api/v1/channels/{channel}/read"),
                &peer_token,
                json!({"read_seq":1}),
            )
            .await;
            assert_eq!(r.status(), StatusCode::OK);
            for socket in [&mut other, &mut other_second] {
                let events = notices(&f, socket).await;
                if attempt == 0 {
                    assert_eq!(
                        events,
                        vec![
                            json!({"type":"read_position_changed","channel_id":channel,"topic_id":null,"read_seq":1})
                        ]
                    );
                } else {
                    assert!(events.is_empty());
                }
            }
            for socket in [&mut own, &mut own_second] {
                assert!(notices(&f, socket).await.is_empty());
            }
        }
    }
}

async fn denied_recipient(pool: PgPool, denial: &str) {
    let f = fixture(&pool).await;
    let (peer, peer_token) = member(&pool, f.organization).await;
    let response = open_dm(&f, &f.token, peer, false).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let channel = Uuid::parse_str(body(response).await["id"].as_str().unwrap()).unwrap();
    let delivery = &f.state.message_delivery.channel_access.activity;
    delivery.drained().await;
    let own_auth = extract_auth(f.state.clone(), &f.token).await;
    let mut denied_auth = extract_auth(f.state.clone(), &peer_token).await;
    match denial {
        "owner" | "admin" => {
            let (outsider, token) = member(&pool, f.organization).await;
            role(&pool, &f, outsider, denial).await;
            denied_auth = extract_auth(f.state.clone(), &token).await;
        }
        "foreign" => {
            let foreign = organization(&pool).await;
            sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) SELECT $1,id,account_id,'Other Organization','member' FROM users WHERE organization_id=$2 AND id=$3")
                .bind(foreign).bind(f.organization).bind(peer).execute(&pool).await.unwrap();
            denied_auth.identity.organization.organization_id = foreign;
        }
        "revoked" => {
            sqlx::query("DELETE FROM dm_discovery WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.organization).bind(channel).bind(peer).execute(&pool).await.unwrap();
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(f.organization).bind(channel).bind(peer).execute(&pool).await.unwrap();
        }
        "lapsed" => {
            sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2")
                .bind(f.organization).bind(peer).execute(&pool).await.unwrap();
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(f.organization)
                .bind(peer)
                .execute(&pool)
                .await
                .unwrap();
            denied_auth = extract_auth(f.state.clone(), &peer_token).await;
        }
        "deactivated" => {
            sqlx::query("UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2")
                .bind(f.organization).bind(peer).execute(&pool).await.unwrap();
            denied_auth.membership_revision = sqlx::query_scalar(
                "SELECT membership_revision FROM users WHERE organization_id=$1 AND id=$2",
            )
            .bind(f.organization)
            .bind(peer)
            .fetch_one(&pool)
            .await
            .unwrap();
            // Keep a current grant in this fixture so activity alone must deny it.
            sqlx::query("UPDATE channel_members SET membership_revision=$4 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
                .bind(f.organization).bind(channel).bind(peer).bind(denied_auth.membership_revision).execute(&pool).await.unwrap();
        }
        "revision" => {
            denied_auth.membership_revision += 1;
        }
        "session" => {
            sqlx::query("UPDATE account_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1")
                .bind(denied_auth.session_hash())
                .execute(&pool)
                .await
                .unwrap();
        }
        _ => panic!("unknown denial"),
    }
    let allowed = delivery.register(&own_auth);
    let denied = delivery.register(&denied_auth);
    // Include the denied candidate deliberately: the publication query must prove access.
    delivery
        .arm_dm(
            f.organization,
            vec![
                (channel, f.member, false),
                (channel, denied_auth.identity.member.id, false),
            ],
        )
        .committed(f.state.pool.clone());
    delivery.drained().await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), allowed.next())
            .await
            .unwrap()
            .unwrap()
            .event,
        Notice::DmListChanged
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(30), denied.next())
            .await
            .is_err(),
        "{denial}"
    );
    // DM activity and read notices use exactly the same batched predicate.
    for event in [
        Notice::ChannelActivity {
            channel_id: channel,
            seq: 1,
        },
        Notice::ReadPositionChanged {
            channel_id: channel,
            topic_id: None,
            read_seq: 1,
        },
    ] {
        delivery.spawn(f.state.pool.clone(), f.organization, event.clone(), None);
        delivery.drained().await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), allowed.next())
                .await
                .unwrap()
                .unwrap()
                .event,
            event
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), denied.next())
                .await
                .is_err(),
            "{denial}"
        );
    }
}
#[fukulow_test::test]
async fn dm_notice_denies_nonparticipant_owner_with_participant_control(pool: PgPool) {
    denied_recipient(pool, "owner").await;
}
#[fukulow_test::test]
async fn dm_notice_denies_nonparticipant_admin_with_participant_control(pool: PgPool) {
    denied_recipient(pool, "admin").await;
}
#[fukulow_test::test]
async fn dm_notice_denies_other_organization_with_participant_control(pool: PgPool) {
    denied_recipient(pool, "foreign").await;
}
#[fukulow_test::test]
async fn dm_notice_denies_revoked_grant_with_participant_control(pool: PgPool) {
    denied_recipient(pool, "revoked").await;
}
#[fukulow_test::test]
async fn dm_notice_denies_lapsed_grant_with_participant_control(pool: PgPool) {
    denied_recipient(pool, "lapsed").await;
}
#[fukulow_test::test]
async fn dm_notice_denies_deactivated_member_with_participant_control(pool: PgPool) {
    denied_recipient(pool, "deactivated").await;
}
#[fukulow_test::test]
async fn dm_notice_denies_stale_revision_with_participant_control(pool: PgPool) {
    denied_recipient(pool, "revision").await;
}
#[fukulow_test::test]
async fn dm_notice_denies_ended_session_with_participant_control(pool: PgPool) {
    denied_recipient(pool, "session").await;
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 256 * 1024).await.unwrap()).unwrap()
}

#[fukulow_test::test]
async fn dm_loss_retires_paused_query_enqueue_and_first_handoff_without_revival(pool: PgPool) {
    use crate::channels::activity::pause;
    for phase in ["dm_snapshot", "dm_authorized", "handoff"] {
        let f = fixture(&pool).await;
        let (peer, token) = member(&pool, f.organization).await;
        let r = open_dm(&f, &f.token, peer, false).await;
        let channel = Uuid::parse_str(body(r).await["id"].as_str().unwrap()).unwrap();
        let delivery = &f.state.message_delivery.channel_access.activity;
        delivery.drained().await;
        let a = extract_auth(f.state.clone(), &f.token).await;
        let b = extract_auth(f.state.clone(), &token).await;
        let allowed = delivery.register(&a);
        let stale = Arc::new(delivery.register(&b));
        let gate = if phase == "handoff" {
            crate::channels::activity::pause_member(f.organization, channel, phase, Some(peer))
        } else {
            pause(f.organization, channel, phase)
        };
        delivery
            .arm_dm(
                f.organization,
                vec![(channel, f.member, false), (channel, peer, false)],
            )
            .committed(f.state.pool.clone());
        let next = if phase == "handoff" {
            let stale = stale.clone();
            Some(tokio::spawn(async move { stale.next().await }))
        } else {
            None
        };
        tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        // Conservative A8 epoch retirement is irreversible even when current access exists again.
        delivery.retire(f.organization, peer);
        gate.release.add_permits(1);
        delivery.drained().await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), allowed.next())
                .await
                .unwrap()
                .unwrap()
                .event,
            Notice::DmListChanged
        );
        if let Some(next) = next {
            next.abort();
            let _ = next.await;
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(30), stale.next())
                .await
                .is_err(),
            "{phase}"
        );
        delivery
            .arm_dm(f.organization, vec![(channel, peer, false)])
            .committed(f.state.pool.clone());
        delivery.drained().await;
        assert_eq!(
            stale.next().await.unwrap().event,
            Notice::DmListChanged,
            "fresh {phase}"
        );
    }
}

#[fukulow_test::test]
async fn dm_fallback_retires_lost_grant_provenance_before_regrant_and_fresh_work_succeeds(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (peer, token) = member(&pool, f.organization).await;
    let r = open_dm(&f, &f.token, peer, false).await;
    let channel = Uuid::parse_str(body(r).await["id"].as_str().unwrap()).unwrap();
    let delivery = &f.state.message_delivery.channel_access.activity;
    delivery.drained().await;
    let a = extract_auth(f.state.clone(), &f.token).await;
    let b = extract_auth(f.state.clone(), &token).await;
    let allowed = delivery.register(&a);
    let stale = delivery.register(&b);
    let gate = crate::channels::activity::pause(f.organization, channel, "dm_authorized");
    delivery
        .arm_dm(
            f.organization,
            vec![(channel, f.member, false), (channel, peer, false)],
        )
        .committed(f.state.pool.clone());
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    // Lose the fast signal and replace the durable lifetime while the old query is paused.
    sqlx::query("UPDATE channel_members SET grant_id=$4 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(f.organization).bind(channel).bind(peer).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    delivery
        .check(
            &f.state.pool,
            crate::auth::SubscriptionScope::Member(f.organization, peer),
        )
        .await;
    gate.release.add_permits(1);
    delivery.drained().await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), allowed.next())
            .await
            .unwrap()
            .unwrap()
            .event,
        Notice::DmListChanged
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(30), stale.next())
            .await
            .is_err()
    );
    delivery
        .arm_dm(f.organization, vec![(channel, peer, false)])
        .committed(f.state.pool.clone());
    delivery.drained().await;
    assert_eq!(stale.next().await.unwrap().event, Notice::DmListChanged);
}

#[fukulow_test::test]
async fn dm_commit_rollback_emits_nothing_and_confirmed_commit_publishes(pool: PgPool) {
    let f = fixture(&pool).await;
    let (peer, token) = member(&pool, f.organization).await;
    let mut own = connect(&f, &f.token).await;
    let mut other = connect(&f, &token).await;
    sqlx::raw_sql("CREATE FUNCTION reject_dm_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected rollback' USING ERRCODE='23514'; END $$; CREATE CONSTRAINT TRIGGER reject_dm_commit AFTER INSERT ON channels DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.kind='dm') EXECUTE FUNCTION reject_dm_commit();")
        .execute(&pool).await.unwrap();
    assert_eq!(
        open_dm(&f, &f.token, peer, false).await.status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert!(notices(&f, &mut own).await.is_empty());
    assert!(notices(&f, &mut other).await.is_empty());
    sqlx::query("DROP TRIGGER reject_dm_commit ON channels")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        open_dm(&f, &f.token, peer, false).await.status(),
        StatusCode::CREATED
    );
    for socket in [&mut own, &mut other] {
        assert!(notices(&f, socket).await.contains(&changed()));
    }
}

#[fukulow_test::test]
async fn dm_peer_deactivation_reactivation_and_rename_invalidate_only_current_viewers_and_renewal_gains_only_lapsed_participant(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (peer, token) = member(&pool, f.organization).await;
    let (_, outsider_token) = member(&pool, f.organization).await;
    let mut own = connect(&f, &f.token).await;
    let mut other = connect(&f, &token).await;
    let mut outsider = connect(&f, &outsider_token).await;
    let r = open_dm(&f, &f.token, peer, false).await;
    let channel = Uuid::parse_str(body(r).await["id"].as_str().unwrap()).unwrap();
    for socket in [&mut own, &mut other] {
        notices(&f, socket).await;
    }
    assert!(notices(&f, &mut outsider).await.is_empty());
    let r = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/members/{peer}/deactivate", f.organization),
        &f.token,
        Value::Null,
    )
    .await;
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    raw_closed(&mut other, 4003).await;
    let events = notices(&f, &mut own).await;
    assert!(events.contains(&changed()), "{events:?}");
    assert!(!events.iter().any(|e| matches!(
        e["type"].as_str(),
        Some("channel_access_revoked" | "channel_members_changed")
    )));
    assert!(!notices(&f, &mut outsider).await.contains(&changed()));
    let email: String = sqlx::query_scalar("SELECT a.email FROM accounts a JOIN users u ON u.account_id=a.id WHERE u.organization_id=$1 AND u.id=$2")
        .bind(f.organization).bind(peer).fetch_one(&pool).await.unwrap();
    let r = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/invites", f.organization),
        &f.token,
        json!({"email":email,"role":"guest"}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::CREATED);
    let invite = body(r).await;
    let r = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/invites/accept", f.organization),
        &token,
        json!({"email":email,"name":"Renamed peer","token":invite["token"]}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    let events = notices(&f, &mut own).await;
    assert!(events.contains(&changed()), "{events:?}");
    assert!(!events.iter().any(|e| e["type"] == "channel_access_gained"));
    assert!(!notices(&f, &mut outsider).await.contains(&changed()));
    let r = request(
        &f.app,
        "GET",
        &format!("/api/v1/orgs/{}/dms", f.organization),
        &f.token,
        Value::Null,
    )
    .await;
    let list = body(r).await;
    assert_eq!(list["dms"][0]["peer"]["name"], "Renamed peer");
    let mut fresh = connect(&f, &token).await;
    // Resolution-only open never restores the peer or emits notices.
    assert_eq!(
        open_dm(&f, &f.token, peer, false).await.status(),
        StatusCode::OK
    );
    assert!(notices(&f, &mut own).await.is_empty());
    assert!(notices(&f, &mut fresh).await.is_empty());
    assert_eq!(
        open_dm(&f, &f.token, peer, true).await.status(),
        StatusCode::OK
    );
    assert_eq!(notices(&f, &mut own).await, vec![changed()]);
    let events = notices(&f, &mut fresh).await;
    assert!(events.contains(&changed()));
    assert!(events.contains(&gained(channel)));
    assert!(events.contains(&json!({"type":"members_changed"})));
    assert!(notices(&f, &mut outsider).await.is_empty());
}

#[fukulow_test::test]
async fn dm_notice_first_handoff_yields_to_known_session_and_membership_loss(pool: PgPool) {
    for code in [4001, 4003] {
        let f = fixture(&pool).await;
        owner(&pool, &f).await;
        let (peer, token) = member(&pool, f.organization).await;
        let r = open_dm(&f, &f.token, peer, false).await;
        let channel = Uuid::parse_str(body(r).await["id"].as_str().unwrap()).unwrap();
        let mut denied = connect(&f, &token).await;
        let mut allowed = connect(&f, &f.token).await;
        let gate =
            crate::channels::activity::pause_member(f.organization, channel, "handoff", Some(peer));
        let delivery = &f.state.message_delivery.channel_access.activity;
        delivery
            .arm_dm(
                f.organization,
                vec![(channel, peer, false), (channel, f.member, false)],
            )
            .committed(f.state.pool.clone());
        tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        let (method, path) = if code == 4001 {
            ("DELETE", "/api/v1/session".to_owned())
        } else {
            (
                "POST",
                format!("/api/v1/orgs/{}/members/{peer}/deactivate", f.organization),
            )
        };
        let r = request(
            &f.app,
            method,
            &path,
            if code == 4001 { &token } else { &f.token },
            Value::Null,
        )
        .await;
        assert_eq!(r.status(), StatusCode::NO_CONTENT);
        raw_closed(&mut denied, code).await;
        gate.release.add_permits(1);
        assert!(notices(&f, &mut allowed).await.contains(&changed()));
    }
}

#[fukulow_test::test]
async fn dm_coalesced_list_notice_retires_when_any_contributing_grant_is_lost(pool: PgPool) {
    let f = fixture(&pool).await;
    let (bob, token) = member(&pool, f.organization).await;
    let (carol, _) = member(&pool, f.organization).await;
    let r = open_dm(&f, &f.token, bob, false).await;
    let first = Uuid::parse_str(body(r).await["id"].as_str().unwrap()).unwrap();
    let r = open_dm(&f, &f.token, carol, false).await;
    let second = Uuid::parse_str(body(r).await["id"].as_str().unwrap()).unwrap();
    let delivery = &f.state.message_delivery.channel_access.activity;
    delivery.drained().await;
    let a = extract_auth(f.state.clone(), &f.token).await;
    let b = extract_auth(f.state.clone(), &token).await;
    let denied = delivery.register(&a);
    let control = delivery.register(&b);
    delivery
        .arm_dm(
            f.organization,
            vec![
                (first, f.member, false),
                (second, f.member, false),
                (first, bob, false),
            ],
        )
        .committed(f.state.pool.clone());
    delivery.drained().await;
    sqlx::query("UPDATE channel_members SET grant_id=$4 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(f.organization).bind(first).bind(f.member).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    delivery
        .check(
            &f.state.pool,
            crate::auth::SubscriptionScope::Member(f.organization, f.member),
        )
        .await;
    assert_eq!(control.next().await.unwrap().event, Notice::DmListChanged);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), denied.next())
            .await
            .is_err()
    );
    delivery
        .arm_dm(f.organization, vec![(second, f.member, false)])
        .committed(f.state.pool.clone());
    delivery.drained().await;
    assert_eq!(denied.next().await.unwrap().event, Notice::DmListChanged);
}
