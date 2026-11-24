use super::*;
use crate::test_support::{Gate, Gates};
use std::sync::Arc;
use tracing::instrument::WithSubscriber;

type GateKey = (Uuid, &'static str);
static GATES: Gates<GateKey> = Gates::new();

pub(super) fn pause_reply_parent(key: Uuid) -> Arc<Gate> {
    GATES.register((key, "reply_parent"))
}

pub(crate) async fn pause(channel: Uuid, phase: &'static str) {
    GATES.pause((channel, phase)).await;
}

#[fukulow_test::test]
async fn page_watermarks_share_the_mutation_snapshot_after_the_commit_barrier(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    let root = sent(
        &app,
        &token,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":"original","topic_name":"Topic"}),
    )
    .await;
    let id = root["id"].as_str().unwrap();
    let topic = root["topic_id"].as_str().unwrap();
    let routes = [
        "messages".to_owned(),
        "timeline".into(),
        "topics".into(),
        format!("topics/{topic}/messages"),
        format!("messages/{id}/chain"),
        "reply-counts".into(),
    ];
    let mut w = 1;
    for route in routes {
        for fixed in [false, true] {
            if route == "reply-counts" && fixed {
                continue;
            }
            let gate = GATES.register((channel, "barrier"));
            let read = {
                let (app, token, route, id) =
                    (app.clone(), token.clone(), route.clone(), id.to_owned());
                tokio::spawn(async move {
                    let query = if fixed {
                        format!("?as_of_seq={w}")
                    } else {
                        String::new()
                    };
                    request(
                        &app,
                        if route == "reply-counts" {
                            "POST"
                        } else {
                            "GET"
                        },
                        &format!("/api/v1/channels/{channel}/{route}{query}"),
                        &token,
                        if route == "reply-counts" {
                            json!({"ids":[id]})
                        } else {
                            Value::Null
                        },
                    )
                    .await
                })
            };
            gate.entered().await;
            // An Edit commits after the barrier read of W and before page BEGIN.
            w += 1;
            let mut tx = pool.begin().await.unwrap();
            sqlx::query("UPDATE channel_message_sequences SET seq=$3, mutation_seq=$3 WHERE organization_id=$1 AND channel_id=$2")
                .bind(org).bind(channel).bind(w).execute(&mut *tx).await.unwrap();
            sqlx::query("UPDATE messages SET version=$3,body='edited' WHERE organization_id=$1 AND channel_id=$2")
                .bind(org).bind(channel).bind(w).execute(&mut *tx).await.unwrap();
            tx.commit().await.unwrap();
            gate.release.add_permits(1);
            let response = read.await.unwrap();
            assert_eq!(
                response.status(),
                if fixed {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::OK
                },
                "{route}, fixed={fixed}"
            );
            let data = body(response).await;
            if fixed {
                assert_eq!(
                    data,
                    json!({"error":"snapshot_expired"}),
                    "{route}: no partial page"
                );
            } else {
                assert_eq!(data["as_of_seq"], w, "{route}");
                if route != "reply-counts" {
                    assert!(data.to_string().contains("edited"), "{route}: {data}");
                }
            }
        }
    }
}

#[fukulow_test::test]
async fn mutation_after_snapshot_watermark_cannot_replace_the_page_body(pool: PgPool) {
    for fixed in [false, true] {
        let (app, org, _, channel, token) = fixture(&pool).await;
        sent(&app, &token, channel, input(Uuid::new_v4(), "original")).await;
        let gate = GATES.register((channel, "snapshot"));
        let read = {
            let (app, token) = (app.clone(), token.clone());
            tokio::spawn(async move {
                request(
                    &app,
                    "GET",
                    &format!(
                        "/api/v1/channels/{channel}/messages{}",
                        if fixed { "?as_of_seq=1" } else { "" }
                    ),
                    &token,
                    Value::Null,
                )
                .await
            })
        };
        gate.entered().await;
        let mut tx = pool.begin().await.unwrap();
        sqlx::query("UPDATE channel_message_sequences SET seq=2,mutation_seq=2 WHERE organization_id=$1 AND channel_id=$2").bind(org).bind(channel).execute(&mut *tx).await.unwrap();
        sqlx::query("UPDATE messages SET body='edited',version=2 WHERE organization_id=$1 AND channel_id=$2").bind(org).bind(channel).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        gate.release.add_permits(1);
        let response = read.await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let data = body(response).await;
        assert_eq!(data["as_of_seq"], 1);
        assert_eq!(data["messages"][0]["body"], "original");
        assert_eq!(data["messages"][0]["version"], 1);
    }
}

#[fukulow_test::test]
async fn bootstrap_uses_explicit_event_watermark_without_visible_messages(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    sqlx::query(
        "INSERT INTO channel_message_sequences (organization_id,channel_id,seq) VALUES ($1,$2,7)",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    let page = body(
        request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/messages"),
            &token,
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(page["as_of_seq"], 7);
    assert_eq!(page["messages"], json!([]));
    assert!(Uuid::parse_str(page["history_generation"].as_str().unwrap()).is_ok());
}

#[fukulow_test::test]
async fn history_generation_rotation_is_explicit_scoped_and_owner_only(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    let other = organization(&pool).await;
    let generations = async || {
        sqlx::query_as::<_, (Uuid, Uuid)>(
            "SELECT organization_id,history_generation FROM organizations ORDER BY organization_id",
        )
        .fetch_all(&pool)
        .await
        .unwrap()
    };
    let before = generations().await;
    // Constructing the application never rotates either Organization.
    let _ = router(&pool).await;
    assert_eq!(generations().await, before);
    assert_eq!(
        crate::auth::history::rotate(&pool, Some(org))
            .await
            .unwrap(),
        1
    );
    let after = generations().await;
    assert_ne!(
        before.iter().find(|r| r.0 == org),
        after.iter().find(|r| r.0 == org)
    );
    assert_eq!(
        before.iter().find(|r| r.0 == other),
        after.iter().find(|r| r.0 == other)
    );
    let app_pool = crate::test_app_pool(pool.clone()).await;
    assert!(crate::database::organization(&app_pool, org, async |tx: &mut sqlx::PgConnection| {
        sqlx::query("UPDATE organizations SET history_generation=gen_random_uuid() WHERE organization_id=$1").bind(org).execute(tx).await
    }).await.is_err());
    let old = before.iter().find(|r| r.0 == org).unwrap().1;
    let response = request(
        &app,
        "GET",
        &format!("/api/v1/channels/{channel}/messages?history_generation={old}"),
        &token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        body(response).await,
        json!({"error":"history_generation_changed"})
    );
    let stable = generations().await;
    assert!(
        crate::auth::history::rotate(&pool, Some(Uuid::new_v4()))
            .await
            .is_err()
    );
    assert_eq!(generations().await, stable);
    assert_eq!(crate::auth::history::rotate(&pool, None).await.unwrap(), 2);
    assert!(generations().await.iter().all(|r| !stable.contains(r)));
}

#[fukulow_test::test]
async fn fresh_send_preflight_reads_generation_only_when_supplied(pool: PgPool) {
    let (_, org, sender, channel, _) = fixture(&pool).await;
    let app_pool = crate::test_app_pool(pool.clone()).await;
    let generation = crate::auth::history::generation(&mut pool.acquire().await.unwrap(), org)
        .await
        .unwrap();
    for requested in [None, Some(generation)] {
        let output = crate::observability::tests::Capture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_writer(output.clone())
            .json()
            .finish();
        let result = committed(
            &app_pool,
            org,
            (sender, 0),
            channel,
            &SendMessageRequest {
                history_generation: requested,
                reply_to: None,
                topic_name: None,
                client_message_id: Uuid::new_v4(),
                body: "fresh send".into(),
            },
        )
        .with_subscriber(subscriber)
        .await;
        assert!(result.unwrap().is_none());
        let standalone_reads = output
            .events()
            .iter()
            .filter(|event| {
                event["fields"]["db.statement"]
                    .as_str()
                    .is_some_and(|sql| sql.trim() == crate::auth::history::GENERATION_SQL)
            })
            .count();
        assert_eq!(standalone_reads, usize::from(requested.is_some()));
    }
}

#[fukulow_test::test]
async fn send_checks_generation_again_after_preflight_and_returns_write_generation(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    for with_generation in [true, false] {
        let old = crate::auth::history::generation(&mut pool.acquire().await.unwrap(), org)
            .await
            .unwrap();
        let key = Uuid::new_v4();
        let mut request = input(key, "rotation during send");
        if with_generation {
            request["history_generation"] = json!(old);
        }
        let gate = limiter::pause_after_charge(key);
        let pending = tokio::spawn({
            let (app, token, request) = (app.clone(), token.clone(), request.clone());
            async move { send(&app, &token, channel, request).await }
        });
        gate.entered().await;
        // Preflight accepted the request. Rotate before persistence can start.
        assert_eq!(
            crate::auth::history::rotate(&pool, Some(org))
                .await
                .unwrap(),
            1
        );
        let current = crate::auth::history::generation(&mut pool.acquire().await.unwrap(), org)
            .await
            .unwrap();
        assert_ne!(current, old);
        gate.release.add_permits(1);
        let response = pending.await.unwrap();
        if with_generation {
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(
                body(response).await,
                json!({"error":"history_generation_changed"})
            );
            let mut stale_fresh = input(Uuid::new_v4(), "fresh send with stale epoch");
            stale_fresh["history_generation"] = json!(old);
            let response = send(&app, &token, channel, stale_fresh).await;
            assert_eq!(response.status(), StatusCode::CONFLICT);
            assert_eq!(
                body(response).await,
                json!({"error":"history_generation_changed"})
            );
        } else {
            assert_eq!(response.status(), StatusCode::CREATED);
            let message = body(response).await;
            assert_eq!(message["created_seq"], 1);
            assert_eq!(message["history_generation"], json!(current));
            assert_eq!(sent(&app, &token, channel, request).await, message);
        }
    }
}

#[fukulow_test::test]
async fn send_epoch_does_not_expose_private_or_foreign_channels(pool: PgPool) {
    let (app, org, owner, public, token) = fixture(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, org, private, owner, true).await;
    let nonmember = member(&pool, org, Uuid::new_v4()).await;
    let foreign_org = organization(&pool).await;
    let foreign_sender = Uuid::new_v4();
    let foreign = member(&pool, foreign_org, foreign_sender).await;
    let foreign_channel = Uuid::new_v4();
    channel(&pool, foreign_org, foreign_channel, foreign_sender, false).await;

    for (credential, target, control) in [
        (&nonmember, private, public),
        (&foreign, public, foreign_channel),
    ] {
        let first = sent(&app, credential, control, input(Uuid::new_v4(), "allowed")).await;
        for with_generation in [false, true] {
            let mut request = input(Uuid::new_v4(), "check authorization first");
            if with_generation {
                request["history_generation"] = json!(Uuid::new_v4());
            }
            let denied = send(&app, credential, target, request.clone()).await;
            assert_eq!(denied.status(), StatusCode::NOT_FOUND);
            assert_eq!(body(denied).await, json!({"error":"channel not found"}));
            if with_generation {
                request["history_generation"] = first["history_generation"].clone();
            }
            sent(&app, credential, control, request).await;
        }
    }
    assert_eq!(
        sent(
            &app,
            &token,
            private,
            input(Uuid::new_v4(), "private grant control")
        )
        .await["created_seq"],
        1
    );
}

#[fukulow_test::test]
async fn fixed_windows_expire_atomically_but_creations_keep_old_watermarks(pool: PgPool) {
    let (app, org, _, channel, token) = fixture(&pool).await;
    let root = sent(
        &app,
        &token,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":"one","topic_name":"Topic"}),
    )
    .await;
    sent(&app, &token, channel, input(Uuid::new_v4(), "two")).await;
    let generation = root["history_generation"].as_str().unwrap();
    let topic = root["topic_id"].as_str().unwrap();
    let id = root["id"].as_str().unwrap();
    let routes = [
        "messages".to_owned(),
        "timeline".to_owned(),
        "topics".to_owned(),
        format!("topics/{topic}/messages"),
        format!("messages/{id}/chain"),
    ];
    for route in &routes {
        let response = request(
            &app,
            "GET",
            &format!(
                "/api/v1/channels/{channel}/{route}?as_of_seq=1&history_generation={generation}"
            ),
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{route}");
        assert_eq!(body(response).await["as_of_seq"], 1);
    }
    sqlx::query("UPDATE channel_message_sequences SET mutation_seq=2 WHERE organization_id=$1 AND channel_id=$2")
        .bind(org).bind(channel).execute(&pool).await.unwrap();
    for route in &routes {
        let response = request(
            &app,
            "GET",
            &format!(
                "/api/v1/channels/{channel}/{route}?as_of_seq=1&history_generation={generation}"
            ),
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{route}");
        assert_eq!(
            body(response).await,
            json!({"error":"snapshot_expired"}),
            "{route}: no partial page"
        );
        let response = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/{route}?history_generation={generation}"),
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "{route}: fresh page");
        let page = body(response).await;
        assert_eq!(page["as_of_seq"], 2);
        assert_eq!(page["history_generation"], generation);
    }
}

#[fukulow_test::test]
async fn generation_and_expiry_denials_preserve_channel_authorization(pool: PgPool) {
    let (app, org, owner, public, token) = fixture(&pool).await;
    let private = Uuid::new_v4();
    channel(&pool, org, private, owner, true).await;
    let stranger = member(&pool, org, Uuid::new_v4()).await;
    let guest_id = Uuid::new_v4();
    let guest = member(&pool, org, guest_id).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(guest_id)
        .execute(&pool)
        .await
        .unwrap();
    let foreign_org = organization(&pool).await;
    let foreign = member(&pool, foreign_org, Uuid::new_v4()).await;
    for target in [public, private] {
        sent(&app, &token, target, input(Uuid::new_v4(), "private state")).await;
        sqlx::query("UPDATE channel_message_sequences SET mutation_seq=1 WHERE organization_id=$1 AND channel_id=$2").bind(org).bind(target).execute(&pool).await.unwrap();
    }
    for (target, credential) in [
        (private, &stranger),
        (public, &guest),
        (private, &foreign),
        (public, &foreign),
        (Uuid::new_v4(), &token),
    ] {
        for suffix in [
            format!("history_generation={}", Uuid::new_v4()),
            "as_of_seq=0".into(),
        ] {
            for route in ["messages", "timeline", "topics", "events"] {
                let response = request(
                    &app,
                    "GET",
                    &format!("/api/v1/channels/{target}/{route}?after_seq=0&{suffix}"),
                    credential,
                    Value::Null,
                )
                .await;
                assert_eq!(
                    response.status(),
                    StatusCode::NOT_FOUND,
                    "{route}: {target}"
                );
                assert_eq!(body(response).await, json!({"error":"channel not found"}));
            }
        }
    }
    // Positive controls use the same protected Channel and floor.
    let ok = request(
        &app,
        "GET",
        &format!("/api/v1/channels/{private}/timeline"),
        &token,
        Value::Null,
    )
    .await;
    assert_eq!(ok.status(), StatusCode::OK);
    let expired = request(
        &app,
        "GET",
        &format!("/api/v1/channels/{private}/timeline?as_of_seq=0"),
        &token,
        Value::Null,
    )
    .await;
    assert_eq!(expired.status(), StatusCode::CONFLICT);
}

#[fukulow_test::test]
async fn generation_guards_counts_sends_and_dm_denials_without_changing_receipts(pool: PgPool) {
    let (app, org, _, _, token) = fixture(&pool).await;
    let peer = Uuid::new_v4();
    let peer_token = member(&pool, org, peer).await;
    let response = request(
        &app,
        "POST",
        "/api/v1/dms",
        &token,
        json!({"member_id":peer}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let dm: Uuid = body(response).await["id"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let key = Uuid::new_v4();
    let original = sent(&app, &token, dm, input(key, "durable intent")).await;
    let old = original["history_generation"].as_str().unwrap();
    crate::auth::history::rotate(&pool, Some(org))
        .await
        .unwrap();
    sqlx::query("UPDATE channel_message_sequences SET mutation_seq=1 WHERE organization_id=$1 AND channel_id=$2")
        .bind(org).bind(dm).execute(&pool).await.unwrap();
    for role in ["member", "owner", "admin", "guest"] {
        let outsider = Uuid::new_v4();
        let credential = member(&pool, org, outsider).await;
        sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(outsider)
            .bind(role)
            .execute(&pool)
            .await
            .unwrap();
        for route in [
            "messages".to_owned(),
            "timeline".to_owned(),
            format!("messages/{}/chain", original["id"].as_str().unwrap()),
        ] {
            for query in [format!("history_generation={old}"), "as_of_seq=0".into()] {
                let response = request(
                    &app,
                    "GET",
                    &format!("/api/v1/channels/{dm}/{route}?{query}"),
                    &credential,
                    Value::Null,
                )
                .await;
                assert_eq!(response.status(), StatusCode::NOT_FOUND, "{role}: {route}");
                assert_eq!(body(response).await, json!({"error":"channel not found"}));
            }
        }
        let denied = request(
            &app,
            "POST",
            &format!("/api/v1/channels/{dm}/reply-counts"),
            &credential,
            json!({"ids":[original["id"]],"history_generation":old}),
        )
        .await;
        assert_eq!(denied.status(), StatusCode::NOT_FOUND, "{role}: counts");
    }
    for (method, path, input) in [
        (
            "GET",
            format!("/api/v1/channels?history_generation={old}"),
            Value::Null,
        ),
        (
            "GET",
            format!("/api/v1/dms?history_generation={old}"),
            Value::Null,
        ),
        (
            "GET",
            format!("/api/v1/channels/{dm}/events?after_seq=0&history_generation={old}"),
            Value::Null,
        ),
        (
            "POST",
            format!("/api/v1/channels/{dm}/reply-counts"),
            json!({"ids":[original["id"]],"history_generation":old}),
        ),
        (
            "PUT",
            format!("/api/v1/channels/{dm}/read"),
            json!({"read_seq":1,"history_generation":old}),
        ),
        (
            "POST",
            format!("/api/v1/channels/{dm}/messages"),
            json!({"client_message_id":key,"body":"durable intent","history_generation":old}),
        ),
    ] {
        let response = request(&app, method, &path, &token, input).await;
        assert_eq!(response.status(), StatusCode::CONFLICT, "{method} {path}");
        assert_eq!(
            body(response).await,
            json!({"error":"history_generation_changed"})
        );
    }
    let restored = sent(&app, &token, dm, input(key, "durable intent")).await;
    assert_eq!(restored["id"], original["id"]);
    assert_eq!(restored["created_seq"], 1);
    assert_ne!(restored["history_generation"], old);
    for credential in [&token, &peer_token] {
        let fresh = body(
            request(
                &app,
                "GET",
                &format!("/api/v1/channels/{dm}/messages"),
                credential,
                Value::Null,
            )
            .await,
        )
        .await;
        assert_eq!(fresh["history_generation"], restored["history_generation"]);
        assert_eq!(fresh["messages"], json!([restored]));
        let expired = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{dm}/messages?as_of_seq=0"),
            credential,
            Value::Null,
        )
        .await;
        assert_eq!(expired.status(), StatusCode::CONFLICT);
        assert_eq!(body(expired).await, json!({"error":"snapshot_expired"}));
    }
}
