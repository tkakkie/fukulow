use super::*;

#[sqlx::test]
async fn channel_manager_denial_matrix_preserves_grants_unread_and_notifications(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (target, _) = f.user("member").await;
    f.add(target).await;
    // Changes and both kinds of no-op must authorize equally.
    for role in ["member", "guest", "owner", "admin"] {
        let (id, token) = f.user(role).await;
        for value in [true, false] {
            f.denied(
                &token,
                f.channel,
                target,
                value,
                StatusCode::NOT_FOUND,
                "channel not found",
            )
            .await;
        }
        f.add(id).await;
        if role == "member" || role == "guest" {
            for target in [target, f.creator] {
                for value in [true, false] {
                    f.denied(
                        &token,
                        f.channel,
                        target,
                        value,
                        StatusCode::FORBIDDEN,
                        "forbidden",
                    )
                    .await;
                }
            }
            for add in [true, false] {
                let before = snapshot(&f.pools.admin).await;
                assert_eq!(
                    mutation(&f.app, &token, f.channel, target, add)
                        .await
                        .status(),
                    StatusCode::FORBIDDEN
                );
                assert_eq!(snapshot(&f.pools.admin).await, before);
            }
        } else {
            assert_eq!(
                manager(&f.app, &token, f.channel, target, true)
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
            assert_eq!(
                manager(&f.app, &token, f.channel, target, false)
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
        }
    }
    let public = create(&f.app, &f.token, "Public", "public").await;
    let public = Uuid::parse_str(public["id"].as_str().unwrap()).unwrap();
    let (owner, ot) = f.user("owner").await;
    for value in [true, false] {
        f.denied(
            &ot,
            public,
            target,
            value,
            StatusCode::BAD_REQUEST,
            "channel_manager_private_only",
        )
        .await;
    }
    let (guest, _) = f.user("guest").await;
    f.add(guest).await;
    let (absent, _) = f.user("member").await;
    let (inactive, _) = f.user("member").await;
    f.add(inactive).await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(f.org)
        .bind(inactive)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    let foreign = organization(&f.pools.admin).await;
    let foreign_id = Uuid::new_v4();
    let ft = member(&f.pools.admin, foreign, foreign_id, "member").await;
    let foreign_channel = create(&f.app, &ft, "Foreign", "private").await;
    let foreign_channel = Uuid::parse_str(foreign_channel["id"].as_str().unwrap()).unwrap();
    let other = create(&f.app, &ot, "Other private", "private").await;
    let other = Uuid::parse_str(other["id"].as_str().unwrap()).unwrap();
    grant(&f.pools.admin, f.org, other, f.creator).await;
    let (stale, _) = f.user("member").await;
    f.add(stale).await;
    sqlx::query("UPDATE channel_members SET membership_revision=-1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(f.org).bind(f.channel).bind(stale).execute(&f.pools.admin).await.unwrap();
    for value in [true, false] {
        for id in [Uuid::new_v4(), foreign_id, inactive] {
            f.denied(
                &f.token,
                f.channel,
                id,
                value,
                StatusCode::NOT_FOUND,
                "member_not_found",
            )
            .await;
        }
        for id in [absent, stale] {
            f.denied(
                &f.token,
                f.channel,
                id,
                value,
                StatusCode::NOT_FOUND,
                "channel_grant_not_found",
            )
            .await;
        }
        f.denied(
            &f.token,
            f.channel,
            guest,
            value,
            StatusCode::BAD_REQUEST,
            "channel_manager_guest",
        )
        .await;
        for channel in [foreign_channel, Uuid::new_v4()] {
            f.denied(
                &f.token,
                channel,
                foreign_id,
                value,
                StatusCode::NOT_FOUND,
                "channel not found",
            )
            .await;
        }
        f.denied(
            &f.token,
            other,
            owner,
            value,
            StatusCode::FORBIDDEN,
            "forbidden",
        )
        .await;
        let before = snapshot(&f.pools.admin).await;
        let response = request(
            &f.app,
            "PATCH",
            &format!(
                "/api/v1/orgs/{}/channels/{}/members/{target}",
                f.org, f.channel
            ),
            &ft,
            json!({"manager":value}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(response).await,
            json!({"error":"organization_unavailable"})
        );
        assert_eq!(snapshot(&f.pools.admin).await, before);
    }
    for add in [true, false] {
        let before = snapshot(&f.pools.admin).await;
        assert_eq!(
            mutation(&f.app, &f.token, other, owner, add).await.status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(snapshot(&f.pools.admin).await, before);
    }
    f.pools.app.close().await;
}

#[sqlx::test]
async fn channel_manager_rechecks_right_grant_role_and_revision_after_auth(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let (actor, token) = f.user("member").await;
    let (target, _) = f.user("member").await;
    f.add(target).await;
    for loss in ["right", "grant", "guest", "inactive", "revision"] {
        assert_eq!(
            mutation(&f.app, &f.token, f.channel, actor, true)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            manager(&f.app, &f.token, f.channel, actor, true)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        let auth = extract_auth(f.state.clone(), &token).await;
        let mut manager_auths = Vec::new();
        for _ in 0..2 {
            manager_auths.push(extract_auth(f.state.clone(), &token).await);
        }
        match loss {
            "right" => {
                assert_eq!(
                    manager(&f.app, &f.token, f.channel, actor, false)
                        .await
                        .status(),
                    StatusCode::NO_CONTENT
                );
            }
            "grant" => {
                assert_eq!(
                    mutation(&f.app, &f.token, f.channel, actor, false)
                        .await
                        .status(),
                    StatusCode::NO_CONTENT
                );
            }
            "guest" => {
                let (_, ot) = f.user("owner").await;
                assert_eq!(
                    change(&f.app, &ot, actor, "guest").await.status(),
                    StatusCode::OK
                );
            }
            _ => {
                sqlx::query(
                    "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
                )
                .bind(f.org)
                .bind(actor)
                .execute(&f.pools.admin)
                .await
                .unwrap();
                if loss == "revision" {
                    sqlx::query(
                        "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(f.org)
                    .bind(actor)
                    .execute(&f.pools.admin)
                    .await
                    .unwrap();
                }
            }
        }
        let before = snapshot(&f.pools.admin).await;
        let calls = f.observed.calls.load(Ordering::SeqCst);
        for (value, captured) in [true, false].into_iter().zip(manager_auths) {
            let response = super::super::members::change_manager(
                State(f.state.clone()),
                captured,
                Ok(axum::extract::Path((f.org, f.channel, target))),
                ApiJson(super::super::members::ChangeChannelManagerRequest { manager: value }),
            )
            .await
            .unwrap_err()
            .into_response();
            assert_eq!(
                response.status(),
                if loss == "right" || loss == "guest" {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::NOT_FOUND
                }
            );
        }
        for add in [true, false] {
            assert!(
                super::super::members::mutate(&f.state, &auth, f.channel, target, add)
                    .await
                    .is_err()
            );
        }
        assert_eq!(snapshot(&f.pools.admin).await, before);
        assert_eq!(f.observed.calls.load(Ordering::SeqCst), calls);
        sqlx::query(
            "UPDATE users SET role='member',deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
        )
        .bind(f.org)
        .bind(actor)
        .execute(&f.pools.admin)
        .await
        .unwrap();
    }
    f.pools.app.close().await;
}
