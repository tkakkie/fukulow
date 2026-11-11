use super::*;
use crate::auth::SessionChanges;
type GateKey = (Uuid, String, i64);
static LOSS_GATES: LazyLock<Mutex<HashMap<GateKey, Arc<Gate>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn gate(channel: Uuid, phase: &str, seq: i64) -> Arc<Gate> {
    let g = Arc::new(Gate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    LOSS_GATES
        .lock()
        .unwrap()
        .insert((channel, phase.into(), seq), g.clone());
    g
}
pub(crate) async fn pause(channel: Uuid, phase: &str, seq: i64) {
    let g = LOSS_GATES
        .lock()
        .unwrap()
        .remove(&(channel, phase.into(), seq));
    if let Some(g) = g {
        g.entered.add_permits(1);
        g.release.acquire().await.unwrap().forget();
    }
}
async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(channel)
    .bind(member)
    .execute(pool)
    .await
    .unwrap();
}
async fn loss(f: &Fixture, pool: &PgPool, reader: Uuid, channel: Uuid, role: bool) {
    if role {
        sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
            .bind(f.organization)
            .bind(reader)
            .execute(pool)
            .await
            .unwrap();
        f.state
            .session_changes
            .recheck_subscriptions(pool, crate::auth::SubscriptionScope::All)
            .await;
    } else {
        assert_eq!(
            request(
                &f.app,
                "DELETE",
                &format!("/api/v1/channels/{channel}/members/{reader}"),
                &f.token,
                Value::Null
            )
            .await
            .status(),
            StatusCode::NO_CONTENT
        );
    }
}
async fn owner(pool: &PgPool, f: &Fixture) {
    sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(f.member)
        .execute(pool)
        .await
        .unwrap();
}
pub(super) async fn access_lost(socket: &mut Client, channel: Uuid) {
    assert_eq!(
        event(socket).await,
        json!({"type":"channel_access_lost","channel_id":channel})
    );
}

#[sqlx::test]
async fn idle_all_sessions_and_effective_loss_preserve_other_channels_and_redundant_grants(
    pool: PgPool,
) {
    for case in ["private", "guest", "role"] {
        let f = fixture(&pool).await;
        owner(&pool, &f).await;
        let (reader, token) = member(&pool, f.organization).await;
        let channel = if case == "private" {
            channel(&pool, f.organization, f.member, true).await
        } else {
            f.channel
        };
        if case != "role" {
            grant(&pool, f.organization, channel, reader).await;
        }
        if case == "guest" {
            sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                .bind(f.organization)
                .bind(reader)
                .execute(&pool)
                .await
                .unwrap();
        }
        let other = super::channel(&pool, f.organization, f.member, false).await;
        grant(&pool, f.organization, other, reader).await;
        let second = format!("{}.{}", f.organization, Uuid::new_v4().simple());
        sqlx::query("INSERT INTO account_sessions (token_hash,account_id) SELECT $1,account_id FROM users WHERE organization_id=$2 AND id=$3").bind(Sha256::digest(second.as_bytes()).to_vec()).bind(f.organization).bind(reader).execute(&pool).await.unwrap();
        let mut sockets = vec![
            f.server.connect(&token).await,
            f.server.connect(&token).await,
            f.server.connect(&second).await,
        ];
        for s in &mut sockets {
            subscribe(s, channel, 0).await;
            ready(s, channel, 0).await;
            subscribe(s, other, 0).await;
            ready(s, other, 0).await;
        }
        loss(&f, &pool, reader, channel, case == "role").await;
        for s in &mut sockets {
            access_lost(s, channel).await;
            subscribe(s, channel, 0).await;
            assert_eq!(event(s).await["code"], "channel_not_found");
        }
        // The explicit public grant survives Role->Guest. Removing a redundant
        // public grant from a non-Guest never ends access or resets Unread.
        let control = send(&f, &f.token, other, Uuid::new_v4(), "unaffected").await;
        for s in &mut sockets {
            assert_eq!(event(s).await["message"], control);
        }
        if case == "private" {
            let before:i64=sqlx::query_scalar("SELECT read_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.organization).bind(other).bind(reader).fetch_one(&pool).await.unwrap();
            loss(&f, &pool, reader, other, false).await;
            for s in &mut sockets {
                silent(s).await;
            }
            let after:i64=sqlx::query_scalar("SELECT read_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.organization).bind(other).bind(reader).fetch_one(&pool).await.unwrap();
            assert_eq!(before, after);
            let next = send(&f, &f.token, other, Uuid::new_v4(), "still visible").await;
            for s in &mut sockets {
                assert_eq!(event(s).await["message"], next);
            }
        }
    }
}

#[sqlx::test]
async fn observed_loss_discards_queued_live_and_fetched_replay_before_and_during_handoff(
    pool: PgPool,
) {
    for case in ["private", "guest", "role"] {
        for phase in ["live", "page", "frame"] {
            let f = fixture(&pool).await;
            owner(&pool, &f).await;
            let (reader, token) = member(&pool, f.organization).await;
            let c = if case == "private" {
                channel(&pool, f.organization, f.member, true).await
            } else {
                f.channel
            };
            if case != "role" {
                grant(&pool, f.organization, c, reader).await;
            }
            if case == "guest" {
                sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                    .bind(f.organization)
                    .bind(reader)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
            let mut socket = f.server.connect(&token).await;
            let g = gate(
                c,
                phase,
                if phase == "page" {
                    0
                } else if phase == "frame" {
                    2
                } else {
                    1
                },
            );
            if phase == "live" {
                subscribe(&mut socket, c, 0).await;
                ready(&mut socket, c, 0).await;
            }
            for i in 1..=3 {
                send(&f, &f.token, c, Uuid::new_v4(), &format!("message {i}")).await;
            }
            if phase != "live" {
                subscribe(&mut socket, c, 0).await;
            }
            entered(&g).await;
            if phase == "frame" {
                assert_eq!(event(&mut socket).await["message"]["seq"], 1);
            }
            loss(&f, &pool, reader, c, case == "role").await;
            g.release.add_permits(1);
            access_lost(&mut socket, c).await;
            silent(&mut socket).await;
            // An explicit re-grant requires a new subscribe; old queued/fetched
            // frames and a late subscribed handoff cannot restore it.
            grant(&pool, f.organization, c, reader).await;
            silent(&mut socket).await;
            subscribe(&mut socket, c, 0).await;
            for i in 1..=3 {
                assert_eq!(event(&mut socket).await["message"]["seq"], i);
            }
            ready(&mut socket, c, 3).await;
        }
    }
}

#[sqlx::test]
async fn fallback_detects_dropped_signal_remove_regrant_lifetime_and_fails_closed(pool: PgPool) {
    for regrant in [false, true] {
        let organization = organization(&pool).await;
        let (reader, token) = member(&pool, organization).await;
        let channel = channel(&pool, organization, reader, true).await;
        let mut state = state(&pool);
        state.session_changes = SessionChanges::with_recheck_timing(
            Duration::from_millis(50),
            Duration::from_millis(200),
        );
        let app = crate::app(state.clone());
        let server = Server::start(app).await;
        let mut socket = server.connect(&token).await;
        subscribe(&mut socket, channel, 0).await;
        ready(&mut socket, channel, 0).await;
        // Direct SQL intentionally drops the endpoint's fast signal.
        sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(organization).bind(channel).bind(reader).execute(&pool).await.unwrap();
        if regrant {
            grant(&pool, organization, channel, reader).await;
        }
        let start = tokio::time::Instant::now();
        access_lost(&mut socket, channel).await;
        assert!(start.elapsed() < Duration::from_millis(250));
        if regrant {
            subscribe(&mut socket, channel, 0).await;
            ready(&mut socket, channel, 0).await;
        }
        let mut held = pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE channel_members IN ACCESS EXCLUSIVE MODE")
            .execute(&mut *held)
            .await
            .unwrap();
        if regrant {
            let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(
                matches!(frame,tungstenite::Message::Close(Some(close)) if u16::from(close.code)==1011)
            );
        }
        held.rollback().await.unwrap();
    }
}

#[sqlx::test]
async fn ungranted_guest_cannot_join_existing_public_topic_but_explicit_grant_permits_it(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (guest, token) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(guest)
        .execute(&pool)
        .await
        .unwrap();
    let root = topics::topic_send(&f, &f.token, f.channel, Uuid::new_v4()).await;
    let mut observer = f.server.connect(&f.token).await;
    subscribe(&mut observer, f.channel, 1).await;
    ready(&mut observer, f.channel, 1).await;
    let input = json!({"client_message_id":Uuid::new_v4(),"body":"Join existing Topic","topic_name":"Release"});
    let path = format!("/api/v1/channels/{}/messages", f.channel);
    let response = request(&f.app, "POST", &path, &token, input.clone()).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let error: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    assert_eq!(error, json!({"error":"channel not found"}));
    let persisted: (i64, i64, i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM messages WHERE organization_id=$1 AND channel_id=$2),
         (SELECT count(*) FROM topics WHERE organization_id=$1 AND channel_id=$2),
         (SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2),
         message_count,last_seq FROM topics WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(f.organization)
    .bind(f.channel)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(persisted, (1, 1, 1, 1, 1));
    f.state.message_delivery.flush().await;
    silent(&mut observer).await;
    grant(&pool, f.organization, f.channel, guest).await;
    let response = request(&f.app, "POST", &path, &token, input).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let joined: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 32768).await.unwrap()).unwrap();
    assert_eq!(joined["topic_id"], root["topic_id"]);
    assert_eq!(joined["seq"], 2);
    assert_eq!(event(&mut observer).await["message"], joined);
    f.state.message_delivery.flush().await;
    silent(&mut observer).await;
}

#[sqlx::test]
async fn effective_loss_http_denial_matrix_including_guest_mark_read_has_positive_controls(
    pool: PgPool,
) {
    for case in ["guest_none", "guest_removed", "demoted", "private_removed"] {
        let f = fixture(&pool).await;
        owner(&pool, &f).await;
        let (reader, token) = member(&pool, f.organization).await;
        let c = if case == "private_removed" {
            channel(&pool, f.organization, f.member, true).await
        } else {
            f.channel
        };
        if case == "guest_none" || case == "guest_removed" {
            sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                .bind(f.organization)
                .bind(reader)
                .execute(&pool)
                .await
                .unwrap();
        }
        let root = send(&f, &f.token, c, Uuid::new_v4(), "root").await;
        let root = root["id"].as_str().unwrap();
        let topic_response = request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{c}/messages"),
            &f.token,
            json!({"client_message_id":Uuid::new_v4(),"body":"Topic root","topic_name":"Topic"}),
        )
        .await;
        let topic_message: Value =
            serde_json::from_slice(&to_bytes(topic_response.into_body(), 32768).await.unwrap())
                .unwrap();
        let topic = topic_message["topic_id"].as_str().unwrap();
        let intents = [
            json!({"client_message_id":Uuid::new_v4(),"body":"ordinary"}),
            json!({"client_message_id":Uuid::new_v4(),"body":"Topic","topic_name":"Created before loss"}),
            json!({"client_message_id":Uuid::new_v4(),"body":"Reply","reply_to":root}),
        ];
        if case != "guest_none" {
            if case != "demoted" {
                grant(&pool, f.organization, c, reader).await;
            }
            for input in &intents {
                assert_eq!(
                    request(
                        &f.app,
                        "POST",
                        &format!("/api/v1/channels/{c}/messages"),
                        &token,
                        input.clone()
                    )
                    .await
                    .status(),
                    StatusCode::CREATED
                );
            }
            loss(&f, &pool, reader, c, case == "demoted").await;
        }
        let positions:i64=sqlx::query_scalar("SELECT count(*) FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.organization).bind(c).bind(reader).fetch_one(&pool).await.unwrap();
        assert_eq!(positions, 0);
        let before:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM messages WHERE organization_id=$1 AND channel_id=$2),(SELECT count(*) FROM topics WHERE organization_id=$1 AND channel_id=$2),(SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2)").bind(f.organization).bind(c).fetch_one(&pool).await.unwrap();
        let reads = [
            "messages".into(),
            "timeline".into(),
            "topics".into(),
            format!("topics/{topic}"),
            format!("topics/{topic}/messages"),
            format!("messages/{root}/chain"),
        ];
        for suffix in &reads {
            assert_eq!(
                request(
                    &f.app,
                    "GET",
                    &format!("/api/v1/channels/{c}/{suffix}"),
                    &token,
                    Value::Null
                )
                .await
                .status(),
                StatusCode::NOT_FOUND,
                "{case}: {suffix}"
            );
        }
        for suffix in ["read".into(), format!("topics/{topic}/read")] {
            let r = request(
                &f.app,
                "PUT",
                &format!("/api/v1/channels/{c}/{suffix}"),
                &token,
                json!({"read_seq":999}),
            )
            .await;
            assert_eq!(r.status(), StatusCode::NOT_FOUND);
            let err: Value =
                serde_json::from_slice(&to_bytes(r.into_body(), 32768).await.unwrap()).unwrap();
            assert_eq!(err, json!({"error":"channel not found"}));
        }
        for input in &intents {
            for retry in [false, true] {
                let mut input = input.clone();
                if !retry {
                    input["client_message_id"] = json!(Uuid::new_v4());
                }
                assert_eq!(
                    request(
                        &f.app,
                        "POST",
                        &format!("/api/v1/channels/{c}/messages"),
                        &token,
                        input
                    )
                    .await
                    .status(),
                    StatusCode::NOT_FOUND
                );
            }
        }
        let list = request(&f.app, "GET", "/api/v1/channels", &token, Value::Null).await;
        let list: Value =
            serde_json::from_slice(&to_bytes(list.into_body(), 32768).await.unwrap()).unwrap();
        assert!(
            list["channels"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["id"] != c.to_string())
        );
        let after:(i64,i64,i64)=sqlx::query_as("SELECT (SELECT count(*) FROM messages WHERE organization_id=$1 AND channel_id=$2),(SELECT count(*) FROM topics WHERE organization_id=$1 AND channel_id=$2),(SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2)").bind(f.organization).bind(c).fetch_one(&pool).await.unwrap();
        assert_eq!(before, after);
        // Explicit grant permits all reads and HTTP mark-read, and establishes
        // the current committed baseline rather than reviving the old position.
        grant(&pool, f.organization, c, reader).await;
        for suffix in reads {
            assert_eq!(
                request(
                    &f.app,
                    "GET",
                    &format!("/api/v1/channels/{c}/{suffix}"),
                    &token,
                    Value::Null
                )
                .await
                .status(),
                StatusCode::OK
            );
        }
        let r = request(
            &f.app,
            "PUT",
            &format!("/api/v1/channels/{c}/read"),
            &token,
            json!({"read_seq":999}),
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK);
        let position: Value =
            serde_json::from_slice(&to_bytes(r.into_body(), 32768).await.unwrap()).unwrap();
        assert_eq!(position["read_seq"], before.2);
    }
}

#[sqlx::test]
async fn subscribe_registration_racing_removal_never_hands_off_a_stale_subscription(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (reader, token) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(reader)
        .execute(&pool)
        .await
        .unwrap();
    grant(&pool, f.organization, f.channel, reader).await;
    let g = gate(f.channel, "registered", 0);
    let mut socket = f.server.connect(&token).await;
    subscribe(&mut socket, f.channel, 0).await;
    entered(&g).await;
    loss(&f, &pool, reader, f.channel, false).await;
    g.release.add_permits(1);
    access_lost(&mut socket, f.channel).await;
    silent(&mut socket).await;
    subscribe(&mut socket, f.channel, 0).await;
    denied(&mut socket, f.channel).await;
}

#[sqlx::test]
async fn denied_management_and_ungranted_guest_subscriptions_emit_no_protected_or_loss_events(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (reader, token) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(reader)
        .execute(&pool)
        .await
        .unwrap();
    let mut guest = f.server.connect(&token).await;
    subscribe(&mut guest, f.channel, 0).await;
    denied(&mut guest, f.channel).await;
    send(
        &f,
        &f.token,
        f.channel,
        Uuid::new_v4(),
        "Guest cannot receive",
    )
    .await;
    silent(&mut guest).await;
    grant(&pool, f.organization, f.channel, reader).await;
    subscribe(&mut guest, f.channel, 0).await;
    assert_eq!(event(&mut guest).await["message"]["seq"], 1);
    ready(&mut guest, f.channel, 1).await;
    let mut owner = f.server.connect(&f.token).await;
    subscribe(&mut owner, f.channel, 1).await;
    ready(&mut owner, f.channel, 1).await;
    for method in ["POST", "DELETE"] {
        let path = if method == "POST" {
            format!("/api/v1/channels/{}/members", f.channel)
        } else {
            format!("/api/v1/channels/{}/members/{}", f.channel, f.member)
        };
        assert_eq!(
            request(&f.app, method, &path, &token, json!({"member_id":f.member}))
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        silent(&mut guest).await;
        silent(&mut owner).await;
    }
    assert_eq!(
        request(
            &f.app,
            "POST",
            &format!("/api/v1/channels/{}/members", f.channel),
            &f.token,
            json!({"member_id":Uuid::new_v4()})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    silent(&mut guest).await;
    silent(&mut owner).await;
    let positive = send(
        &f,
        &f.token,
        f.channel,
        Uuid::new_v4(),
        "Grant remains usable",
    )
    .await;
    assert_eq!(event(&mut guest).await["message"], positive);
    assert_eq!(event(&mut owner).await["message"], positive);
}

#[sqlx::test]
async fn continuous_public_role_changes_adopt_grant_lifetimes_and_membership_loss_keeps_4003(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let (reader, token) = member(&pool, f.organization).await;
    grant(&pool, f.organization, f.channel, reader).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(reader)
        .execute(&pool)
        .await
        .unwrap();
    let mut socket = f.server.connect(&token).await;
    subscribe(&mut socket, f.channel, 0).await;
    ready(&mut socket, f.channel, 0).await;
    for role in ["member", "guest"] {
        assert_eq!(
            request(
                &f.app,
                "PATCH",
                &format!("/api/v1/orgs/{}/members/{reader}/role", f.organization),
                &f.token,
                json!({"role":role})
            )
            .await
            .status(),
            StatusCode::OK
        );
        if role == "member" {
            loss(&f, &pool, reader, f.channel, false).await;
            grant(&pool, f.organization, f.channel, reader).await;
        }
        silent(&mut socket).await;
    }
    let positive = post(&f, f.channel).await;
    assert_eq!(event(&mut socket).await["message"], positive);
    // With the public shortcut gone the newly adopted lifetime must now fence
    // a remove/re-grant whose fast signal is deliberately dropped.
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(f.organization)
    .bind(f.channel)
    .bind(reader)
    .execute(&pool)
    .await
    .unwrap();
    grant(&pool, f.organization, f.channel, reader).await;
    f.state
        .session_changes
        .recheck_subscriptions(&pool, crate::auth::SubscriptionScope::All)
        .await;
    access_lost(&mut socket, f.channel).await;
    subscribe(&mut socket, f.channel, 1).await;
    ready(&mut socket, f.channel, 1).await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(reader)
        .execute(&pool)
        .await
        .unwrap();
    f.state
        .session_changes
        .recheck_subscriptions(&pool, crate::auth::SubscriptionScope::All)
        .await;
    let frame = socket.next().await.unwrap().unwrap();
    assert!(
        matches!(frame,tungstenite::Message::Close(Some(close)) if u16::from(close.code)==4003)
    );
}

#[sqlx::test]
async fn replay_snapshot_after_removal_commit_denies_even_without_a_fast_signal(pool: PgPool) {
    for guest in [false, true] {
        let f = fixture(&pool).await;
        let (reader, token) = member(&pool, f.organization).await;
        let target = if guest {
            f.channel
        } else {
            channel(&pool, f.organization, f.member, true).await
        };
        grant(&pool, f.organization, target, reader).await;
        if guest {
            sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
                .bind(f.organization)
                .bind(reader)
                .execute(&pool)
                .await
                .unwrap();
        }
        let canonical = send(&f, &f.token, target, Uuid::new_v4(), "authorized control").await;
        let g = gate(target, "snapshot", 0);
        let mut socket = f.server.connect(&token).await;
        subscribe(&mut socket, target, 0).await;
        entered(&g).await;
        sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.organization).bind(target).bind(reader).execute(&pool).await.unwrap();
        g.release.add_permits(1);
        access_lost(&mut socket, target).await;
        silent(&mut socket).await;
        let mut control = f.server.connect(&f.token).await;
        subscribe(&mut control, target, 0).await;
        assert_eq!(event(&mut control).await["message"], canonical);
        ready(&mut control, target, 1).await;
    }
}
