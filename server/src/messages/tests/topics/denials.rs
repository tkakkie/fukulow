use super::*;

const SURFACES: [&str; 7] = [
    "new", "existing", "retry", "timeline", "topics", "summary", "history",
];

async fn surface(
    app: &Router,
    token: &str,
    channel: Uuid,
    topic: &str,
    key: Uuid,
    name: &str,
) -> Response {
    let (method, suffix, input) = match name {
        "new" => (
            "POST",
            "messages".into(),
            topic_input(Uuid::new_v4(), &format!("New {}", Uuid::new_v4())),
        ),
        "existing" => (
            "POST",
            "messages".into(),
            topic_input(Uuid::new_v4(), "Existing"),
        ),
        "retry" => ("POST", "messages".into(), topic_input(key, "Existing")),
        "summary" => ("GET", format!("topics/{topic}"), Value::Null),
        "history" => ("GET", format!("topics/{topic}/messages"), Value::Null),
        route => ("GET", route.into(), Value::Null),
    };
    request(
        app,
        method,
        &format!("/api/v1/channels/{channel}/{suffix}"),
        token,
        input,
    )
    .await
}

#[fukulow_test::test]
async fn topic_rest_denial_matrix_has_positive_controls_and_authorization_before_admission(
    pool: PgPool,
) {
    for denial in [
        "cross_organization",
        "private_nonmember",
        "deactivated",
        "removed_grant",
    ] {
        let (_, org, owner, channel, owner_token) = fixture(&pool).await;
        let other = if denial == "cross_organization" {
            organization(&pool).await
        } else {
            org
        };
        let viewer = Uuid::new_v4();
        let token = member(&pool, other, viewer).await;
        let state = AppState::for_test(pool.clone()).await;
        let delivery = state.message_delivery.clone();
        let app = crate::app(state);
        let key = Uuid::new_v4();
        let canonical = sent(
            &app,
            if other == org { &token } else { &owner_token },
            channel,
            topic_input(key, "Existing"),
        )
        .await;
        let topic = canonical["topic_id"].as_str().unwrap();
        for name in SURFACES {
            assert!(
                surface(
                    &app,
                    if other == org { &token } else { &owner_token },
                    channel,
                    topic,
                    key,
                    name
                )
                .await
                .status()
                .is_success(),
                "positive {denial}/{name}"
            );
        }
        if denial == "private_nonmember" || denial == "removed_grant" {
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(org).bind(channel).bind(owner).execute(&pool).await.unwrap();
            if denial == "removed_grant" {
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
                for name in SURFACES {
                    assert!(
                        surface(&app, &token, channel, topic, key, name)
                            .await
                            .status()
                            .is_success()
                    );
                }
                sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
            }
        } else if denial == "deactivated" {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(viewer)
                .execute(&pool)
                .await
                .unwrap();
        }
        // Saturation must not hide any denial, including a canonical retry.
        let waiters = (0..CHANNEL_QUEUE_CAP)
            .map(|_| {
                delivery
                    .admission(&pool)
                    .reserve_send(org, channel)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        for name in SURFACES {
            let response = surface(&app, &token, channel, topic, key, name).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{denial}/{name}");
            let expected = if denial == "deactivated" {
                "organization_unavailable"
            } else {
                "channel not found"
            };
            assert_eq!(
                body(response).await,
                json!({"error":expected}),
                "{denial}/{name}"
            );
            assert_eq!(delivery.admission(&pool).queued_sends(), CHANNEL_QUEUE_CAP);
        }
        if other != org {
            let scoped_token = format!("{org}.unused");
            for name in SURFACES {
                // Explicitly request the other Organization with the real credential.
                let (method, suffix, input) = if ["new", "existing", "retry"].contains(&name) {
                    ("POST", "messages".into(), topic_input(key, "Existing"))
                } else if name == "summary" {
                    ("GET", format!("topics/{topic}"), Value::Null)
                } else if name == "history" {
                    ("GET", format!("topics/{topic}/messages"), Value::Null)
                } else {
                    ("GET", name.into(), Value::Null)
                };
                let path = scoped_path(
                    &format!("/api/v1/channels/{channel}/{suffix}"),
                    &scoped_token,
                );
                let response = request(&app, method, &path, &token, input).await;
                assert_eq!(response.status(), StatusCode::NOT_FOUND);
                assert_eq!(
                    body(response).await,
                    json!({"error":"organization_unavailable"})
                );
            }
        }
        drop(waiters);
        for name in SURFACES {
            assert!(
                surface(&app, &owner_token, channel, topic, key, name)
                    .await
                    .status()
                    .is_success(),
                "control after {denial}/{name}"
            );
        }
    }
}

#[fukulow_test::test]
async fn topic_stale_member_revision_denies_every_rest_surface_after_auth(pool: PgPool) {
    for reactivate in [false, true] {
        let (app, org, owner, channel, token) = fixture(&pool).await;
        let key = Uuid::new_v4();
        let canonical = sent(&app, &token, channel, topic_input(key, "Existing")).await;
        let topic: Uuid = canonical["topic_id"].as_str().unwrap().parse().unwrap();
        let mut captured = Vec::new();
        for _ in SURFACES {
            captured.push(super::super::membership::captured_auth(&pool, &token).await);
        }
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        if reactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(owner)
                .execute(&pool)
                .await
                .unwrap();
        }
        let state = AppState::for_test(pool.clone()).await;
        for (name, auth) in SURFACES.into_iter().zip(captured) {
            let page = || {
                Ok(Query(ListProjectionQuery {
                    as_of_seq: None,
                    before_position: None,
                    limit: None,
                }))
            };
            let response = match name {
                "new" | "existing" | "retry" => {
                    send_message(
                        State(state.clone()),
                        DeferredOrganizationAuth(Some(auth)),
                        Ok(Path((org, channel))),
                        ApiJson(SendMessageRequest {
                            client_message_id: if name == "retry" { key } else { Uuid::new_v4() },
                            body: "Topic Message".into(),
                            reply_to: None,
                            topic_name: Some(if name == "new" { "New" } else { "Existing" }.into()),
                        }),
                    )
                    .await
                }
                "timeline" => {
                    list_timeline(State(state.clone()), auth, Ok(Path((org, channel))), page())
                        .await
                }
                "topics" => {
                    list_topics(State(state.clone()), auth, Ok(Path((org, channel))), page()).await
                }
                "summary" => {
                    topic_summary(State(state.clone()), auth, Ok(Path((org, channel, topic)))).await
                }
                "history" => {
                    topic_history(
                        State(state.clone()),
                        auth,
                        Ok(Path((org, channel, topic))),
                        Ok(Query(ListMessagesQuery {
                            after_seq: None,
                            before_seq: None,
                            limit: None,
                        })),
                    )
                    .await
                }
                _ => unreachable!(),
            }
            .unwrap_err()
            .into_response();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                body(response).await,
                json!({"error":"organization_unavailable"}),
                "{name}, reactivate={reactivate}"
            );
        }
        if !reactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(owner)
                .execute(&pool)
                .await
                .unwrap();
        }
        // A fresh current-revision Member remains an authorized positive control.
        for name in SURFACES {
            assert!(
                surface(&app, &token, channel, &topic.to_string(), key, name)
                    .await
                    .status()
                    .is_success()
            );
        }
    }
}

#[fukulow_test::test]
async fn topic_unknown_foreign_channel_and_foreign_organization_are_indistinguishable(
    pool: PgPool,
) {
    let (app, org, owner, channel, token) = fixture(&pool).await;
    let own = sent(&app, &token, channel, topic_input(Uuid::new_v4(), "Own")).await;
    let other_channel = Uuid::new_v4();
    super::super::channel(&pool, org, other_channel, owner, false).await;
    let foreign_channel = sent(
        &app,
        &token,
        other_channel,
        topic_input(Uuid::new_v4(), "Other Channel"),
    )
    .await;
    let (foreign_app, _, _, foreign_id, foreign_token) = fixture(&pool).await;
    let foreign_org = sent(
        &foreign_app,
        &foreign_token,
        foreign_id,
        topic_input(Uuid::new_v4(), "Other Organization"),
    )
    .await;
    for suffix in ["", "/messages"] {
        assert_eq!(
            request(
                &app,
                "GET",
                &format!(
                    "/api/v1/channels/{channel}/topics/{}{suffix}",
                    own["topic_id"].as_str().unwrap()
                ),
                &token,
                Value::Null
            )
            .await
            .status(),
            StatusCode::OK
        );
        for id in [
            Uuid::new_v4().to_string(),
            foreign_channel["topic_id"].as_str().unwrap().into(),
            foreign_org["topic_id"].as_str().unwrap().into(),
        ] {
            let response = request(
                &app,
                "GET",
                &format!("/api/v1/channels/{channel}/topics/{id}{suffix}"),
                &token,
                Value::Null,
            )
            .await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(body(response).await, json!({"error":"topic_not_found"}));
        }
    }
    // No send-by-id surface can smuggle a foreign Topic into a Message.
    let mut input = topic_input(Uuid::new_v4(), "Own");
    input["topic_id"] = foreign_channel["topic_id"].clone();
    assert_error(
        send(&app, &token, channel, input).await,
        StatusCode::BAD_REQUEST,
    )
    .await;
}
