use super::*;

async fn surface(app: &Router, token: &str, channel: Uuid, topic: &str, name: &str) -> Response {
    let (method, suffix) = match name {
        "mark_channel" => ("PUT", "read".into()),
        "mark_topic" => ("PUT", format!("topics/{topic}/read")),
        "summary" => ("GET", format!("topics/{topic}")),
        other => ("GET", other.into()),
    };
    request(
        app,
        method,
        &format!("/api/v1/channels/{channel}/{suffix}"),
        token,
        json!({"read_seq":100}),
    )
    .await
}

const SURFACES: [&str; 5] = [
    "mark_channel",
    "mark_topic",
    "topics",
    "summary",
    "timeline",
];

#[fukulow_test::test]
async fn unread_denials_have_positive_controls_and_never_change_positions(pool: PgPool) {
    for denial in [
        "cross_organization",
        "private_nonmember",
        "revoked_grant",
        "deactivated",
    ] {
        let (app, org, owner_id, channel, owner) = fixture(&pool).await;
        let viewer_id = Uuid::new_v4();
        let other_org = if denial == "cross_organization" {
            organization(&pool).await
        } else {
            org
        };
        let viewer = member(&pool, other_org, viewer_id).await;
        let topic = post(&app, &owner, channel, Some("Topic")).await;
        let t = topic["topic_id"].as_str().unwrap();
        for name in SURFACES {
            let control = if other_org == org { &viewer } else { &owner };
            assert_eq!(
                surface(&app, control, channel, t, name).await.status(),
                StatusCode::OK,
                "positive {denial}/{name}"
            );
        }
        if denial == "private_nonmember" || denial == "revoked_grant" {
            sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(org).bind(channel).bind(owner_id).execute(&pool).await.unwrap();
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
            if denial == "revoked_grant" {
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(org).bind(channel).bind(viewer_id).execute(&pool).await.unwrap();
                for name in SURFACES {
                    assert_eq!(
                        surface(&app, &viewer, channel, t, name).await.status(),
                        StatusCode::OK
                    );
                }
                sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(viewer_id).execute(&pool).await.unwrap();
            }
        } else if denial == "deactivated" {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(viewer_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        for name in SURFACES {
            assert_eq!(
                surface(&app, &owner, channel, t, name).await.status(),
                StatusCode::OK
            );
        }
        let before: Vec<(Uuid,Uuid,i64)> = sqlx::query_as("SELECT channel_id,member_id,read_seq FROM channel_read_positions ORDER BY organization_id,channel_id,member_id").fetch_all(&pool).await.unwrap();
        let before_topics: Vec<(Uuid,Uuid,Uuid,i64)> = sqlx::query_as("SELECT channel_id,member_id,topic_id,read_seq FROM topic_read_positions ORDER BY organization_id,channel_id,member_id,topic_id").fetch_all(&pool).await.unwrap();
        for name in SURFACES {
            let response = surface(&app, &viewer, channel, t, name).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{denial}/{name}");
            assert_eq!(
                body(response).await,
                json!({"error":if denial=="deactivated" {"organization_unavailable"} else {"channel not found"}})
            );
            assert_eq!(
                surface(&app, &owner, channel, t, name).await.status(),
                StatusCode::OK,
                "owner still authorized {denial}/{name}"
            );
        }
        if denial == "deactivated" {
            let response = request(&app, "GET", "/api/v1/channels", &viewer, Value::Null).await;
            assert_eq!(
                body(response).await,
                json!({"error":"organization_unavailable"})
            );
        } else {
            let listed = channels(&app, &viewer).await;
            assert_eq!(
                listed["channels"],
                json!([]),
                "{denial}: no UnreadChannel entry, including no as_of_seq"
            );
            assert_eq!(
                channels(&app, &owner).await["channels"][0]["id"],
                json!(channel)
            );
        }
        let after: Vec<(Uuid,Uuid,i64)> = sqlx::query_as("SELECT channel_id,member_id,read_seq FROM channel_read_positions ORDER BY organization_id,channel_id,member_id").fetch_all(&pool).await.unwrap();
        assert_eq!(before, after);
        let after_topics: Vec<(Uuid,Uuid,Uuid,i64)> = sqlx::query_as("SELECT channel_id,member_id,topic_id,read_seq FROM topic_read_positions ORDER BY organization_id,channel_id,member_id,topic_id").fetch_all(&pool).await.unwrap();
        assert_eq!(before_topics, after_topics);
        if other_org != org {
            // The foreign Account cannot select the target Organization either.
            for name in SURFACES {
                let suffix = match name {
                    "mark_channel" => "read".into(),
                    "mark_topic" => format!("topics/{t}/read"),
                    "summary" => format!("topics/{t}"),
                    n => n.into(),
                };
                let response = request(
                    &app,
                    if name.starts_with("mark") {
                        "PUT"
                    } else {
                        "GET"
                    },
                    &format!("/api/v1/orgs/{org}/channels/{channel}/{suffix}"),
                    &viewer,
                    json!({"read_seq":100}),
                )
                .await;
                assert_eq!(
                    body(response).await,
                    json!({"error":"organization_unavailable"})
                );
            }
        }
    }
}

#[fukulow_test::test]
async fn unread_rejects_foreign_topics_invalid_inputs_and_stale_member_revision(pool: PgPool) {
    let (app, org, owner_id, channel, owner) = fixture(&pool).await;
    let topic = post(&app, &owner, channel, Some("Existing")).await;
    let t = topic["topic_id"].as_str().unwrap();
    let other_channel = Uuid::new_v4();
    super::super::channel(&pool, org, other_channel, owner_id, false).await;
    let other_topic = post(&app, &owner, other_channel, Some("Other")).await;
    let (foreign_app, _, _, foreign_channel, foreign_owner) = fixture(&pool).await;
    let foreign_topic = post(
        &foreign_app,
        &foreign_owner,
        foreign_channel,
        Some("Foreign"),
    )
    .await;
    for id in [
        Uuid::new_v4().to_string(),
        other_topic["topic_id"].as_str().unwrap().to_string(),
        foreign_topic["topic_id"].as_str().unwrap().to_string(),
    ] {
        let response = surface(&app, &owner, channel, &id, "mark_topic").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(body(response).await, json!({"error":"topic_not_found"}));
    }
    for suffix in ["read".to_string(), format!("topics/{t}/read")] {
        for input in [
            json!({"read_seq":-1}),
            json!({"read_seq":"1"}),
            json!({}),
            json!({"read_seq":1,"member_id":owner_id}),
        ] {
            assert_eq!(
                request(
                    &app,
                    "PUT",
                    &format!("/api/v1/channels/{channel}/{suffix}"),
                    &owner,
                    input
                )
                .await
                .status(),
                StatusCode::BAD_REQUEST
            );
        }
    }
    for reactivate in [false, true] {
        let mut captured = Vec::new();
        for _ in 0..3 {
            captured.push(super::super::membership::captured_auth(&pool, &owner).await);
        }
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(owner_id)
            .execute(&pool)
            .await
            .unwrap();
        if reactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(owner_id)
                .execute(&pool)
                .await
                .unwrap();
        }
        for (scope, auth) in captured.into_iter().enumerate() {
            let state = State(AppState::for_test(pool.clone()).await);
            let response = match scope {
                0 => mark_channel_read(
                    state,
                    auth,
                    Ok(Path((org, channel))),
                    ApiJson(MarkReadRequest { read_seq: 100 }),
                )
                .await
                .unwrap_err()
                .into_response(),
                1 => mark_topic_read(
                    state,
                    auth,
                    Ok(Path((org, channel, t.parse().unwrap()))),
                    ApiJson(MarkReadRequest { read_seq: 100 }),
                )
                .await
                .unwrap_err()
                .into_response(),
                _ => list_channels(state, auth)
                    .await
                    .unwrap_err()
                    .into_response(),
            };
            assert_eq!(
                body(response).await,
                json!({"error":"organization_unavailable"})
            );
        }
        if !reactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(owner_id)
                .execute(&pool)
                .await
                .unwrap();
        }
    }
}
