use super::*;

async fn mutation(app: &Router, token: &str, channel: Uuid, target: Uuid, add: bool) -> Response {
    request(
        app,
        if add { "POST" } else { "DELETE" },
        &if add {
            format!("/api/v1/channels/{channel}/members")
        } else {
            format!("/api/v1/channels/{channel}/members/{target}")
        },
        token,
        json!({"member_id":target}),
    )
    .await
}
async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, target: Uuid) {
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(channel)
    .bind(target)
    .execute(pool)
    .await
    .unwrap();
}
async fn snapshot(pool: &PgPool) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(c) ORDER BY organization_id,channel_id,member_id) FROM channel_members c),(SELECT jsonb_agg(to_jsonb(p) ORDER BY organization_id,channel_id,member_id) FROM channel_read_positions p),(SELECT jsonb_agg(to_jsonb(p) ORDER BY organization_id,channel_id,member_id,topic_id) FROM topic_read_positions p))").fetch_one(pool).await.unwrap()
}
async fn denied(
    pool: &PgPool,
    app: &Router,
    token: &str,
    channel: Uuid,
    target: Uuid,
    add: bool,
    (status, error): (StatusCode, &str),
) {
    let before = snapshot(pool).await;
    let response = mutation(app, token, channel, target, add).await;
    assert_eq!(response.status(), status);
    assert_eq!(body(response).await, json!({"error":error}));
    assert_eq!(snapshot(pool).await, before);
}

#[sqlx::test]
async fn management_denial_matrix_and_idempotent_current_revision_grants(pool: PgPool) {
    let state = AppState::for_test(pool.clone());
    let app = crate::app(state.clone());
    let org = organization(&pool).await;
    let owner = Uuid::new_v4();
    let owner_token = member(&pool, org, owner, "owner").await;
    let private = create(&app, &owner_token, "Managed", "private").await;
    let channel = Uuid::parse_str(private["id"].as_str().unwrap()).unwrap();
    let target = Uuid::new_v4();
    let target_token = member(&pool, org, target, "member").await;
    for role in ["owner", "admin", "member", "guest"] {
        let id = Uuid::new_v4();
        let token = member(&pool, org, id, role).await;
        for add in [true, false] {
            denied(
                &pool,
                &app,
                &token,
                channel,
                target,
                add,
                (StatusCode::NOT_FOUND, "channel not found"),
            )
            .await;
        }
        let list = request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/members"),
            &token,
            Value::Null,
        )
        .await;
        assert_eq!(list.status(), StatusCode::NOT_FOUND);
        grant(&pool, org, channel, id).await;
        if role == "member" || role == "guest" {
            for add in [true, false] {
                denied(
                    &pool,
                    &app,
                    &token,
                    channel,
                    target,
                    add,
                    (StatusCode::FORBIDDEN, "forbidden"),
                )
                .await;
            }
        } else {
            assert_eq!(
                mutation(&app, &token, channel, target, true).await.status(),
                StatusCode::NO_CONTENT
            );
            let before = snapshot(&pool).await;
            assert_eq!(
                mutation(&app, &token, channel, target, true).await.status(),
                StatusCode::NO_CONTENT
            );
            assert_eq!(snapshot(&pool).await, before);
            assert_eq!(
                mutation(&app, &token, channel, target, false)
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
            assert_eq!(
                mutation(&app, &token, channel, target, false)
                    .await
                    .status(),
                StatusCode::NO_CONTENT
            );
        }
        let listed = body(
            request(
                &app,
                "GET",
                &format!("/api/v1/channels/{channel}/members"),
                &token,
                Value::Null,
            )
            .await,
        )
        .await;
        assert!(listed["members"].as_array().unwrap().iter().all(|m| {
            m.as_object()
                .unwrap()
                .keys()
                .all(|k| ["id", "name", "role"].contains(&k.as_str()))
        }));
        assert_eq!(
            mutation(&app, &token, channel, id, false).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            mutation(&app, &token, channel, id, false).await.status(),
            StatusCode::NO_CONTENT
        );
    }
    let foreign_org = organization(&pool).await;
    let foreign = Uuid::new_v4();
    let foreign_token = member(&pool, foreign_org, foreign, "owner").await;
    let foreign_channel = create(&app, &foreign_token, "Foreign", "public").await;
    let foreign_channel = Uuid::parse_str(foreign_channel["id"].as_str().unwrap()).unwrap();
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    for id in [Uuid::new_v4(), foreign, target] {
        for add in [true, false] {
            denied(
                &pool,
                &app,
                &owner_token,
                channel,
                id,
                add,
                (StatusCode::NOT_FOUND, "member_not_found"),
            )
            .await;
        }
    }
    for add in [true, false] {
        denied(
            &pool,
            &app,
            &owner_token,
            foreign_channel,
            target,
            add,
            (StatusCode::NOT_FOUND, "channel not found"),
        )
        .await;
    }
    grant(&pool, org, channel, target).await;
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/members"),
            &target_token,
            Value::Null
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        mutation(&app, &owner_token, channel, target, true)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &app,
            "GET",
            &format!("/api/v1/channels/{channel}/members"),
            &target_token,
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[sqlx::test]
async fn management_rechecks_demoted_deactivated_stale_and_removed_actors(pool: PgPool) {
    for loss in ["demoted", "deactivated", "stale", "removed"] {
        for add in [true, false] {
            let state = AppState::for_test(pool.clone());
            let app = crate::app(state.clone());
            let org = organization(&pool).await;
            let owner = Uuid::new_v4();
            let token = member(&pool, org, owner, "owner").await;
            let admin = Uuid::new_v4();
            let admin_token = member(&pool, org, admin, "admin").await;
            let target = Uuid::new_v4();
            member(&pool, org, target, "member").await;
            let channel = create(&app, &token, "Private", "private").await;
            let channel = Uuid::parse_str(channel["id"].as_str().unwrap()).unwrap();
            grant(&pool, org, channel, admin).await;
            grant(&pool, org, channel, target).await;
            let auth = extract_auth(state.clone(), &admin_token).await;
            match loss {
                "demoted" => {
                    sqlx::query(
                        "UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(org)
                    .bind(admin)
                    .execute(&pool)
                    .await
                    .unwrap();
                }
                "removed" => {
                    assert_eq!(
                        mutation(&app, &token, channel, admin, false).await.status(),
                        StatusCode::NO_CONTENT
                    );
                }
                _ => {
                    sqlx::query(
                        "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
                    )
                    .bind(org)
                    .bind(admin)
                    .execute(&pool)
                    .await
                    .unwrap();
                    if loss == "stale" {
                        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2").bind(org).bind(admin).execute(&pool).await.unwrap();
                    }
                }
            }
            let before = snapshot(&pool).await;
            let error = super::super::members::mutate(&state, &auth, channel, target, add)
                .await
                .unwrap_err()
                .into_response();
            assert_eq!(
                error.status(),
                if loss == "demoted" {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::NOT_FOUND
                }
            );
            assert_eq!(snapshot(&pool).await, before);
        }
    }
}

#[sqlx::test]
async fn private_last_manager_last_grant_and_concurrent_removals_are_serialized(pool: PgPool) {
    for leave in [false, true] {
        let app = router(&pool);
        let org = organization(&pool).await;
        let a = Uuid::new_v4();
        let at = member(&pool, org, a, "admin").await;
        let b = Uuid::new_v4();
        let bt = member(&pool, org, b, "admin").await;
        let m = Uuid::new_v4();
        let mt = member(&pool, org, m, "member").await;
        let g = Uuid::new_v4();
        let gt = member(&pool, org, g, "guest").await;
        let c = create(&app, &at, "Managed", "private").await;
        let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
        for id in [b, m, g] {
            grant(&pool, org, c, id).await;
        }
        let (ar, br) = tokio::join!(
            mutation(&app, &at, c, if leave { a } else { b }, false),
            mutation(&app, &bt, c, if leave { b } else { a }, false)
        );
        let statuses = [ar.status(), br.status()];
        assert_eq!(
            statuses
                .iter()
                .filter(|s| **s == StatusCode::NO_CONTENT)
                .count(),
            1
        );
        let (remaining, token) =
            if mutation(&app, &at, c, m, true).await.status() == StatusCode::NO_CONTENT {
                (a, &at)
            } else {
                (b, &bt)
            };
        denied(
            &pool,
            &app,
            token,
            c,
            remaining,
            false,
            (StatusCode::CONFLICT, "last_channel_manager"),
        )
        .await;
        // Demoting the last Channel manager stays allowed (#231), even with grants.
        sqlx::query("UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(remaining)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| {
                if remaining == b {
                    panic!("Owner fixture needs another Organization Owner: {e}")
                } else {
                    panic!("{e}")
                }
            });
        assert_eq!(
            mutation(&app, token, c, remaining, false).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            mutation(&app, &mt, c, m, false).await.status(),
            StatusCode::NO_CONTENT
        );
        denied(
            &pool,
            &app,
            &gt,
            c,
            g,
            false,
            (StatusCode::CONFLICT, "last_channel_grant"),
        )
        .await;
    }
}

#[sqlx::test]
async fn deactivated_and_stale_managers_never_count_as_usable(pool: PgPool) {
    for stale in [false, true] {
        let app = router(&pool);
        let org = organization(&pool).await;
        let a = Uuid::new_v4();
        let at = member(&pool, org, a, "admin").await;
        let b = Uuid::new_v4();
        member(&pool, org, b, "admin").await;
        let m = Uuid::new_v4();
        member(&pool, org, m, "member").await;
        let c = create(&app, &at, "Managed", "private").await;
        let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
        grant(&pool, org, c, b).await;
        grant(&pool, org, c, m).await;
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(b)
            .execute(&pool)
            .await
            .unwrap();
        if stale {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(org)
                .bind(b)
                .execute(&pool)
                .await
                .unwrap();
        }
        denied(
            &pool,
            &app,
            &at,
            c,
            a,
            false,
            (StatusCode::CONFLICT, "last_channel_manager"),
        )
        .await;
        assert_eq!(
            mutation(&app, &at, c, b, true).await.status(),
            if stale {
                StatusCode::NO_CONTENT
            } else {
                StatusCode::NOT_FOUND
            }
        );
        if stale {
            assert_eq!(
                mutation(&app, &at, c, a, false).await.status(),
                StatusCode::NO_CONTENT
            );
        }
    }
}

#[sqlx::test]
async fn unmanaged_guest_leave_succeeds_and_last_grant_is_protected(pool: PgPool) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let m = Uuid::new_v4();
    let mt = member(&pool, org, m, "member").await;
    let g = Uuid::new_v4();
    let gt = member(&pool, org, g, "guest").await;
    let c = create(&app, &mt, "Unmanaged", "private").await;
    let c = Uuid::parse_str(c["id"].as_str().unwrap()).unwrap();
    grant(&pool, org, c, g).await;
    assert_eq!(
        mutation(&app, &gt, c, g, false).await.status(),
        StatusCode::NO_CONTENT
    );
    grant(&pool, org, c, g).await;
    assert_eq!(
        mutation(&app, &mt, c, m, false).await.status(),
        StatusCode::NO_CONTENT
    );
    denied(
        &pool,
        &app,
        &gt,
        c,
        g,
        false,
        (StatusCode::CONFLICT, "last_channel_grant"),
    )
    .await;
}
