use super::*;

#[fukulow_test::test]
async fn invite_management_http_denials_preserve_state_and_disclose_no_email(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, _, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, _, foreign) = account(&pool, other, Role::Owner).await;
    let (_, _, _, member) = account(&pool, org, Role::Member).await;
    let (_, _, _, guest) = account(&pool, org, Role::Guest).await;
    let (_, inactive, _, inactive_token) = account(&pool, org, Role::Admin).await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(inactive)
        .execute(&pool)
        .await
        .unwrap();
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let i = invite(&app, org, &owner, "hidden@example.invalid", Role::Member).await;
    for (target_org, token, status, error) in [
        (org, None, StatusCode::UNAUTHORIZED, "invalid credentials"),
        (
            org,
            Some(member.as_str()),
            StatusCode::FORBIDDEN,
            "forbidden",
        ),
        (
            org,
            Some(guest.as_str()),
            StatusCode::FORBIDDEN,
            "forbidden",
        ),
        (
            org,
            Some(foreign.as_str()),
            StatusCode::NOT_FOUND,
            "organization_unavailable",
        ),
        (
            Uuid::new_v4(),
            Some(owner.as_str()),
            StatusCode::NOT_FOUND,
            "organization_unavailable",
        ),
        (
            org,
            Some(inactive_token.as_str()),
            StatusCode::NOT_FOUND,
            "organization_unavailable",
        ),
    ] {
        for (method, url) in [
            ("GET", path(target_org)),
            ("DELETE", format!("{}/{}", path(target_org), id(&i))),
        ] {
            let before = snapshot(&pool).await;
            let r = req(&app, method, &url, token, Value::Null).await;
            denied(&pool, r, &before, status, error).await;
        }
    }
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    let owner_invite = invite(
        &app,
        org,
        &owner,
        "owner-hidden@example.invalid",
        Role::Owner,
    )
    .await;
    let foreign_invite = invite(
        &app,
        other,
        &foreign,
        "foreign-hidden@example.invalid",
        Role::Member,
    )
    .await;
    for (invite_id, token) in [
        (id(&owner_invite), &admin),
        (id(&foreign_invite), &owner),
        (Uuid::new_v4(), &owner),
    ] {
        let before = snapshot(&pool).await;
        let r = req(
            &app,
            "DELETE",
            &format!("{}/{invite_id}", path(org)),
            Some(token),
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
    // Listing is successful but gives no hint of an unmanageable Invite.
    let before = snapshot(&pool).await;
    let p = page(&app, org, &admin, None).await;
    assert_eq!(p["invites"].as_array().unwrap().len(), 1);
    assert!(!p.to_string().contains("owner-hidden"));
    assert_eq!(snapshot(&pool).await, before);
    for column in ["accepted_at", "revoked_at", "expires_at"] {
        let i = invite(
            &app,
            org,
            &owner,
            &format!("{column}@example.invalid"),
            Role::Member,
        )
        .await;
        let value = if column == "expires_at" {
            "now()-interval '1 second'"
        } else {
            "now()"
        };
        sqlx::query(&format!(
            "UPDATE invites SET {column}={value} WHERE organization_id=$1 AND id=$2"
        ))
        .bind(org)
        .bind(id(&i))
        .execute(&pool)
        .await
        .unwrap();
        let before = snapshot(&pool).await;
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
        let p = page(&app, org, &owner, None).await;
        assert!(
            !p["invites"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| id(row) == id(&i))
        );
    }
}
