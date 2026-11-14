use super::*;

#[fukulow_test::test]
async fn invite_management_rechecks_role_activity_and_revision_under_lock(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let state = AppState::for_test(pool.clone()).await;
    let app = crate::app(state.clone());
    let i = invite(&app, org, &owner, "protected@example.invalid", Role::Member).await;
    for loss in ["demoted", "inactive", "stale"] {
        for delete in [false, true] {
            let (account_id, member, _, token) = account(&pool, org, Role::Owner).await;
            let auth = captured_auth(org, member, account_id, &token, Role::Owner);
            // Both endpoints succeed for this same actor before its authority changes.
            assert_eq!(
                list_invites(
                    State(state.clone()),
                    captured_auth(org, member, account_id, &token, Role::Owner),
                    Ok(Query(ListInvitesQuery::default()))
                )
                .await
                .unwrap()
                .status(),
                StatusCode::OK
            );
            let mut blocker = pool.begin().await.unwrap();
            members::lock_organization(&mut blocker, org).await.unwrap();
            let pending = tokio::spawn({
                let state = state.clone();
                let target = id(&i);
                async move {
                    if delete {
                        revoke_invite(State(state), auth, Ok(Path((org, target)))).await
                    } else {
                        list_invites(State(state), auth, Ok(Query(ListInvitesQuery::default())))
                            .await
                    }
                    .unwrap_or_else(|e| e.into_response())
                }
            });
            waiting(
                &pool,
                "SELECT organization_id FROM organizations%FOR NO KEY UPDATE",
            )
            .await;
            let sql = match loss {
                "demoted" => "UPDATE users SET role='member' WHERE organization_id=$1 AND id=$2",
                _ => "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
            };
            sqlx::query(sql)
                .bind(org)
                .bind(member)
                .execute(&mut *blocker)
                .await
                .unwrap();
            if loss == "stale" {
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(org)
                .bind(member)
                .execute(&mut *blocker)
                .await
                .unwrap();
            }
            blocker.commit().await.unwrap();
            let before = snapshot(&pool).await;
            let r = tokio::time::timeout(Duration::from_secs(10), pending)
                .await
                .unwrap()
                .unwrap();
            let (status, error) = if loss == "demoted" {
                (StatusCode::FORBIDDEN, "forbidden")
            } else {
                (StatusCode::NOT_FOUND, "organization_unavailable")
            };
            denied(&pool, r, &before, status, error).await;
        }
    }
    // A queued Owner->Admin transition must also recheck the target Role.
    let (account_id, member, _, token) = account(&pool, org, Role::Owner).await;
    let owner_invite = invite(
        &app,
        org,
        &owner,
        "owner-protected@example.invalid",
        Role::Owner,
    )
    .await;
    let mut blocker = pool.begin().await.unwrap();
    members::lock_organization(&mut blocker, org).await.unwrap();
    let pending = tokio::spawn({
        let state = state.clone();
        let target = id(&owner_invite);
        async move {
            revoke_invite(
                State(state),
                captured_auth(org, member, account_id, &token, Role::Owner),
                Ok(Path((org, target))),
            )
            .await
            .unwrap_err()
            .into_response()
        }
    });
    waiting(
        &pool,
        "SELECT organization_id FROM organizations%FOR NO KEY UPDATE",
    )
    .await;
    sqlx::query("UPDATE users SET role='admin' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(member)
        .execute(&mut *blocker)
        .await
        .unwrap();
    blocker.commit().await.unwrap();
    let before = snapshot(&pool).await;
    denied(
        &pool,
        pending.await.unwrap(),
        &before,
        StatusCode::NOT_FOUND,
        "invite_unavailable",
    )
    .await;
}

#[fukulow_test::test]
async fn invite_revoke_and_accept_serialize_in_both_orders_without_partial_writes(
    pool: sqlx::PgPool,
) {
    let org = org(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    for revoke_first in [true, false] {
        let email = format!("{}@new.invalid", Uuid::new_v4());
        let i = invite(&app, org, &owner, &email, Role::Member).await;
        let mut input = accept_input(&i, &email);
        input["password"] = json!("race test password long enough");
        let mut blocker = pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM invites WHERE organization_id=$1 AND id=$2 FOR UPDATE")
            .bind(org)
            .bind(id(&i))
            .fetch_one(&mut *blocker)
            .await
            .unwrap();
        let before = snapshot(&pool).await;
        let delete_path = format!("{}/{}", path(org), id(&i));
        let accept_path = format!("{}/accept", path(org));
        let first = tokio::spawn({
            let app = app.clone();
            let owner = owner.clone();
            let input = input.clone();
            let delete_path = delete_path.clone();
            let accept_path = accept_path.clone();
            async move {
                if revoke_first {
                    req(&app, "DELETE", &delete_path, Some(&owner), Value::Null).await
                } else {
                    req(&app, "POST", &accept_path, None, input).await
                }
            }
        });
        waiting(
            &pool,
            if revoke_first {
                "SELECT role FROM invites%FOR UPDATE"
            } else {
                "SELECT email,role,created_by FROM invites%FOR UPDATE"
            },
        )
        .await;
        let second = tokio::spawn({
            let app = app.clone();
            let owner = owner.clone();
            async move {
                if revoke_first {
                    req(&app, "POST", &accept_path, None, input).await
                } else {
                    req(&app, "DELETE", &delete_path, Some(&owner), Value::Null).await
                }
            }
        });
        waiting(
            &pool,
            "SELECT organization_id FROM organizations%FOR NO KEY UPDATE",
        )
        .await;
        blocker.commit().await.unwrap();
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        if revoke_first {
            assert_eq!(first.status(), StatusCode::NO_CONTENT);
            assert_eq!(second.status(), StatusCode::NOT_FOUND);
            assert_eq!(body(second).await, json!({"error":"invite_unavailable"}));
            let after = snapshot(&pool).await;
            assert_eq!(after[0], before[0]);
            assert_eq!(after[1], before[1]);
            assert_eq!(after[3], before[3]);
        } else {
            assert_eq!(first.status(), StatusCode::OK);
            let accepted = body(first).await;
            assert_eq!(accepted["member"]["role"], "member");
            assert_eq!(second.status(), StatusCode::NOT_FOUND);
            assert_eq!(body(second).await, json!({"error":"invite_unavailable"}));
            let after = snapshot(&pool).await;
            let third = req(
                &app,
                "DELETE",
                &format!("{}/{}", path(org), id(&i)),
                Some(&owner),
                Value::Null,
            )
            .await;
            denied(
                &pool,
                third,
                &after,
                StatusCode::NOT_FOUND,
                "invite_unavailable",
            )
            .await;
            let count:i64=sqlx::query_scalar("SELECT count(*) FROM users u JOIN accounts a ON a.id=u.account_id WHERE u.organization_id=$1 AND a.email=$2 AND u.deactivated_at IS NULL").bind(org).bind(&email).fetch_one(&pool).await.unwrap();
            assert_eq!(count, 1);
        }
    }
}

#[fukulow_test::test]
async fn other_issuers_invites_remain_manageable_and_revocation_is_permanent(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    let (_, issuer, _, issuer_token) = account(&pool, org, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let i = invite(
        &app,
        org,
        &issuer_token,
        "permanent@example.invalid",
        Role::Member,
    )
    .await;
    sqlx::query(
        "UPDATE users SET role='member',deactivated_at=now() WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(issuer)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        page(&app, org, &admin, None).await["invites"][0]["id"],
        i["id"]
    );
    let r = req(
        &app,
        "DELETE",
        &format!("{}/{}", path(org), id(&i)),
        Some(&admin),
        Value::Null,
    )
    .await;
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    for reactivate in [false, true] {
        if reactivate {
            sqlx::query("UPDATE users SET role='owner',deactivated_at=NULL WHERE organization_id=$1 AND id=$2").bind(org).bind(issuer).execute(&pool).await.unwrap();
        }
        let before = snapshot(&pool).await;
        let mut input = accept_input(&i, "permanent@example.invalid");
        input["password"] = json!("permanent revocation password");
        let r = req(&app, "POST", &format!("{}/accept", path(org)), None, input).await;
        denied(
            &pool,
            r,
            &before,
            StatusCode::NOT_FOUND,
            "invite_unavailable",
        )
        .await;
        let r = req(
            &app,
            "DELETE",
            &format!("{}/{}", path(org), id(&i)),
            Some(&owner),
            Value::Null,
        )
        .await;
        denied(
            &pool,
            r,
            &before,
            StatusCode::NOT_FOUND,
            "invite_unavailable",
        )
        .await;
    }
}
