use super::*;

#[sqlx::test]
async fn reply_unknown_foreign_channel_and_foreign_organization_parent_and_anchor_are_identical(
    pool: PgPool,
) {
    let (_, org, owner, channel, token) = fixture(&pool).await;
    let state = AppState::for_test(pool.clone());
    let delivery = state.message_delivery.clone();
    let app = crate::app(state);
    let own = sent(&app, &token, channel, input(Uuid::new_v4(), "Own")).await;
    let other = Uuid::new_v4();
    super::super::channel(&pool, org, other, owner, false).await;
    let foreign_channel = sent(&app, &token, other, input(Uuid::new_v4(), "Other Channel")).await;
    let (foreign_app, _, _, foreign, foreign_token) = fixture(&pool).await;
    let foreign_org = sent(
        &foreign_app,
        &foreign_token,
        foreign,
        input(Uuid::new_v4(), "Other Organization"),
    )
    .await;
    for bad in [json!({"id":Uuid::new_v4()}), foreign_channel, foreign_org] {
        delivery.flush().await;
        let mut queue = delivery.queue(org, (owner, 0), 256);
        queue.subscribe(channel);
        let before = counts(&pool, org, channel).await;
        error(
            send(&app, &token, channel, reply_input(Uuid::new_v4(), &bad)).await,
            StatusCode::NOT_FOUND,
            "reply_parent_not_found",
        )
        .await;
        error(
            chain(&app, &token, channel, id(&bad), "").await,
            StatusCode::NOT_FOUND,
            "reply_chain_not_found",
        )
        .await;
        assert_eq!(counts(&pool, org, channel).await, before);
        delivery.flush().await;
        assert!(queue.events.try_recv().is_err());
        let good = sent(&app, &token, channel, reply_input(Uuid::new_v4(), &own)).await;
        assert_eq!(good["reply_root_id"], own["id"]);
        assert_eq!(
            page(&app, &token, channel, id(&good), "").await["root_id"],
            own["id"]
        );
    }
}

#[sqlx::test]
async fn reply_rest_denial_matrix_retry_and_chain_have_positive_controls_before_saturated_admission(
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
        let state = AppState::for_test(pool.clone());
        let delivery = state.message_delivery.clone();
        let app = crate::app(state);
        let root = sent(
            &app,
            &owner_token,
            channel,
            topics::topic_input(Uuid::new_v4(), "Release"),
        )
        .await;
        let allowed = if other == org { &token } else { &owner_token };
        let intent = reply_input(Uuid::new_v4(), &root);
        let canonical = sent(&app, allowed, channel, intent.clone()).await;
        assert_eq!(
            page(&app, allowed, channel, id(&canonical), "").await["root_id"],
            root["id"]
        );
        if ["private_nonmember", "removed_grant"].contains(&denial) {
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)")
                .bind(org)
                .bind(channel)
                .bind(owner)
                .execute(&pool)
                .await
                .unwrap();
            if denial == "removed_grant" {
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)")
                    .bind(org)
                    .bind(channel)
                    .bind(viewer)
                    .execute(&pool)
                    .await
                    .unwrap();
                assert_eq!(sent(&app, &token, channel, intent.clone()).await, canonical);
                page(&app, &token, channel, id(&root), "").await;
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
        delivery.flush().await;
        let mut queue = delivery.queue(org, (owner, 0), 256);
        queue.subscribe(channel);
        let before = counts(&pool, org, channel).await;
        let waiters = (0..CHANNEL_QUEUE_CAP)
            .map(|_| {
                delivery
                    .admission(&pool)
                    .reserve_send(org, channel)
                    .unwrap()
            })
            .collect::<Vec<_>>();
        let expected = if denial == "deactivated" {
            "organization_unavailable"
        } else {
            "channel not found"
        };
        for value in [intent.clone(), reply_input(Uuid::new_v4(), &root)] {
            error(
                send(&app, &token, channel, value).await,
                StatusCode::NOT_FOUND,
                expected,
            )
            .await;
        }
        for anchor in [id(&root), id(&canonical)] {
            error(
                chain(&app, &token, channel, anchor, "").await,
                StatusCode::NOT_FOUND,
                expected,
            )
            .await;
        }
        if other != org {
            for (method, suffix, input) in [
                ("POST", "messages".to_owned(), intent.clone()),
                ("GET", format!("messages/{}/chain", id(&root)), Value::Null),
            ] {
                error(
                    request(
                        &app,
                        method,
                        &format!("/api/v1/orgs/{org}/channels/{channel}/{suffix}"),
                        &token,
                        input,
                    )
                    .await,
                    StatusCode::NOT_FOUND,
                    "organization_unavailable",
                )
                .await;
            }
        }
        assert_eq!(delivery.admission(&pool).queued_sends(), CHANNEL_QUEUE_CAP);
        assert_eq!(counts(&pool, org, channel).await, before);
        delivery.flush().await;
        assert!(queue.events.try_recv().is_err());
        drop(waiters);
        sent(
            &app,
            &owner_token,
            channel,
            reply_input(Uuid::new_v4(), &root),
        )
        .await;
        assert_eq!(
            page(&app, &owner_token, channel, id(&canonical), "").await["root_id"],
            root["id"]
        );
    }
}

#[sqlx::test]
async fn reply_stale_member_and_queued_access_loss_deny_send_retry_and_chain(pool: PgPool) {
    for denial in ["member", "revision", "grant"] {
        let (_, org, owner, channel, owner_token) = fixture(&pool).await;
        let viewer = Uuid::new_v4();
        let token = member(&pool, org, viewer).await;
        let state = AppState::for_test(pool.clone());
        let delivery = state.message_delivery.clone();
        let app = crate::app(state.clone());
        let root = sent(
            &app,
            &owner_token,
            channel,
            topics::topic_input(Uuid::new_v4(), "Release"),
        )
        .await;
        let intent = reply_input(Uuid::new_v4(), &root);
        let canonical = sent(&app, &token, channel, intent.clone()).await;
        if denial == "grant" {
            sqlx::query(
                "UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2",
            )
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
            for who in [owner, viewer] {
                sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)").bind(org).bind(channel).bind(who).execute(&pool).await.unwrap();
            }
        }
        page(&app, &token, channel, id(&canonical), "").await;
        let new_auth = super::super::membership::captured_auth(&pool, &token).await;
        let send_auth = super::super::membership::captured_auth(&pool, &token).await;
        let chain_auth = super::super::membership::captured_auth(&pool, &token).await;
        let held = delivery
            .admission(&pool)
            .acquire(org, channel, true)
            .await
            .unwrap();
        let queued = {
            let (app, token, intent) = (app.clone(), token.clone(), intent.clone());
            tokio::spawn(async move { send(&app, &token, channel, intent).await })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while delivery.admission(&pool).queued_sends() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        if denial == "grant" {
            sqlx::query("DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
        } else {
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(viewer)
                .execute(&pool)
                .await
                .unwrap();
            if denial == "revision" {
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(org)
                .bind(viewer)
                .execute(&pool)
                .await
                .unwrap();
            }
        }
        delivery.flush().await;
        let mut queue = delivery.queue(org, (owner, 0), 256);
        queue.subscribe(channel);
        let expected = if denial == "grant" {
            "channel not found"
        } else {
            "organization_unavailable"
        };
        drop(held);
        error(queued.await.unwrap(), StatusCode::NOT_FOUND, expected).await;
        let response = send_message(
            State(state.clone()),
            DeferredOrganizationAuth(Some(new_auth)),
            Ok(Path((org, channel))),
            ApiJson(serde_json::from_value(reply_input(Uuid::new_v4(), &root)).unwrap()),
        )
        .await
        .unwrap_err()
        .into_response();
        error(response, StatusCode::NOT_FOUND, expected).await;
        let response = send_message(
            State(state.clone()),
            DeferredOrganizationAuth(Some(send_auth)),
            Ok(Path((org, channel))),
            ApiJson(serde_json::from_value(intent).unwrap()),
        )
        .await
        .unwrap_err()
        .into_response();
        error(response, StatusCode::NOT_FOUND, expected).await;
        let response = reply_chain(
            State(state),
            DeferredOrganizationAuth(Some(chain_auth)),
            Ok(Path((org, channel, id(&canonical)))),
            Ok(Query(ReplyChainQuery {
                after_seq: None,
                limit: None,
            })),
        )
        .await
        .unwrap_err()
        .into_response();
        error(response, StatusCode::NOT_FOUND, expected).await;
        assert_eq!(counts(&pool, org, channel).await, (2, 2, 2));
        delivery.flush().await;
        assert!(queue.events.try_recv().is_err());
        sent(
            &app,
            &owner_token,
            channel,
            reply_input(Uuid::new_v4(), &root),
        )
        .await;
        page(&app, &owner_token, channel, id(&root), "").await;
    }
}

#[sqlx::test]
async fn reply_validation_precedes_organization_denial_but_preserves_session_authentication(
    pool: PgPool,
) {
    let (app, org, member_id, channel, token) = fixture(&pool).await;
    let root = sent(&app, &token, channel, input(Uuid::new_v4(), "Root")).await;
    let invalid = json!({"client_message_id":Uuid::new_v4(),"body":"Reply","reply_to":root["id"],"topic_name":"Forbidden"});
    let unknown = Uuid::new_v4();
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member_id)
        .execute(&pool)
        .await
        .unwrap();
    for scope in [org, unknown] {
        let send_path = format!("/api/v1/orgs/{scope}/channels/{channel}/messages");
        let chain_path = format!("{send_path}/{}/chain", id(&root));
        assert_error(
            request(
                &app,
                "POST",
                &send_path,
                &token,
                input(Uuid::new_v4(), "   "),
            )
            .await,
            StatusCode::BAD_REQUEST,
        )
        .await;
        error(
            request(&app, "POST", &send_path, &token, invalid.clone()).await,
            StatusCode::BAD_REQUEST,
            "reply_topic_not_allowed",
        )
        .await;
        assert_error(
            request(
                &app,
                "GET",
                &format!("{chain_path}?after_seq=-1"),
                &token,
                Value::Null,
            )
            .await,
            StatusCode::BAD_REQUEST,
        )
        .await;
        assert_error(
            request(
                &app,
                "GET",
                &format!("{chain_path}?after_seq=bad"),
                &token,
                Value::Null,
            )
            .await,
            StatusCode::BAD_REQUEST,
        )
        .await;
        error(
            request(
                &app,
                "POST",
                &send_path,
                &token,
                reply_input(Uuid::new_v4(), &root),
            )
            .await,
            StatusCode::NOT_FOUND,
            "organization_unavailable",
        )
        .await;
        error(
            request(&app, "GET", &chain_path, &token, Value::Null).await,
            StatusCode::NOT_FOUND,
            "organization_unavailable",
        )
        .await;
        // Credential rejection still wins over both malformed input and unavailable scope.
        assert_error(
            request(&app, "POST", &send_path, "invalid", invalid.clone()).await,
            StatusCode::UNAUTHORIZED,
        )
        .await;
        assert_error(
            request(&app, "POST", &send_path, "invalid", Value::Null).await,
            StatusCode::UNAUTHORIZED,
        )
        .await;
        assert_error(
            request(
                &app,
                "GET",
                &format!("{chain_path}?limit=0"),
                "invalid",
                Value::Null,
            )
            .await,
            StatusCode::UNAUTHORIZED,
        )
        .await;
    }
    assert_eq!(counts(&pool, org, channel).await, (1, 1, 0));
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member_id)
        .execute(&pool)
        .await
        .unwrap();
    sent(&app, &token, channel, reply_input(Uuid::new_v4(), &root)).await;
    page(&app, &token, channel, id(&root), "").await;
}

#[tokio::test]
async fn reply_send_rejects_invalid_session_without_polling_the_request_body() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let app = router(&pool);
    let request = Request::post(format!(
        "/api/v1/orgs/{}/channels/{}/messages",
        Uuid::new_v4(),
        Uuid::new_v4()
    ))
    .header(header::CONTENT_TYPE, "application/json")
    .header(header::AUTHORIZATION, "Bearer invalid")
    .body(Body::from_stream(futures_util::stream::pending::<
        Result<axum::body::Bytes, std::io::Error>,
    >()))
    .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(1), app.oneshot(request))
        .await
        .unwrap()
        .unwrap();
    assert_error(response, StatusCode::UNAUTHORIZED).await;
}
