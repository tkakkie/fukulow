use super::*;

#[fukulow_test::test]
async fn issued_admin_anchor_denies_after_invite_becomes_owner_role(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, issuer, _, _) = account(&pool, org, Role::Owner).await;
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    seed(&pool, org, issuer, 101, false).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let first = page(&app, org, &admin, None).await;
    let anchor = id(&first["invites"][99]);
    sqlx::query("UPDATE invites SET role='owner' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(anchor)
        .execute(&pool)
        .await
        .unwrap();
    let before = snapshot(&pool).await;
    let r = req(
        &app,
        "GET",
        &format!(
            "{}?cursor={}",
            path(org),
            first["next_cursor"].as_str().unwrap()
        ),
        Some(&admin),
        Value::Null,
    )
    .await;
    denied(&pool, r, &before, StatusCode::BAD_REQUEST, "invalid input").await;
}

#[fukulow_test::test]
async fn issued_admin_anchor_denies_under_another_organization(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, issuer, _, _) = account(&pool, org, Role::Owner).await;
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    let (_, other_issuer, _, other_admin) = account(&pool, other, Role::Admin).await;
    seed(&pool, org, issuer, 101, false).await;
    seed(&pool, other, other_issuer, 101, false).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let first = page(&app, org, &admin, None).await;
    let before = snapshot(&pool).await;
    let r = req(
        &app,
        "GET",
        &format!(
            "{}?cursor={}",
            path(other),
            first["next_cursor"].as_str().unwrap()
        ),
        Some(&other_admin),
        Value::Null,
    )
    .await;
    denied(&pool, r, &before, StatusCode::BAD_REQUEST, "invalid input").await;
}

#[fukulow_test::test]
async fn invite_pages_reach_250_in_order_and_every_invite_can_be_revoked(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
    let mut expected = seed(&pool, org, issuer, 250, false).await;
    expected.sort();
    let later = expected.remove(0);
    sqlx::query("UPDATE invites SET created_at=created_at+interval '1 second' WHERE organization_id=$1 AND id=$2")
        .bind(org).bind(later).execute(&pool).await.unwrap();
    expected.push(later);
    let app = crate::app(AppState::for_test(pool.clone()).await);
    let mut cursor = None;
    let mut seen = vec![];
    for size in [100, 100, 50] {
        let p = page(&app, org, &owner, cursor.as_deref()).await;
        let rows = p["invites"].as_array().unwrap();
        assert_eq!(rows.len(), size);
        for row in rows {
            assert_eq!(row["created_by"], issuer.to_string());
            assert!(row["email"].as_str().unwrap().contains('@'));
            assert_eq!(row["role"], "member");
            assert!(row["expires_at"].as_str().unwrap().ends_with('Z'));
            seen.push(id(row));
            let r = req(
                &app,
                "DELETE",
                &format!("{}/{}", path(org), id(row)),
                Some(&owner),
                Value::Null,
            )
            .await;
            assert_eq!(r.status(), StatusCode::NO_CONTENT);
            assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
            assert!(to_bytes(r.into_body(), 1).await.unwrap().is_empty());
        }
        cursor = p.get("next_cursor").map(|v| v.as_str().unwrap().to_owned());
        assert_eq!(cursor.is_some(), size == 100);
    }
    assert_eq!(seen, expected);
    assert_eq!(page(&app, org, &owner, None).await, json!({"invites":[]}));
}

#[fukulow_test::test]
async fn invite_keyset_survives_earlier_later_and_anchor_lifecycle_changes(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    for change in ["revoked_at", "accepted_at", "expires_at"] {
        sqlx::query("DELETE FROM invites WHERE organization_id=$1")
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
        let mut ids = seed(&pool, org, issuer, 250, false).await;
        ids.sort();
        let first = page(&app, org, &owner, None).await;
        assert_eq!(
            first["invites"]
                .as_array()
                .unwrap()
                .iter()
                .map(id)
                .collect::<Vec<_>>(),
            ids[..100]
        );
        let cursor = first["next_cursor"].as_str().unwrap();
        // Change an earlier row, the exact anchor and a later row between pages.
        let removed = vec![ids[5], ids[99], ids[155]];
        let value = if change == "expires_at" {
            "clock_timestamp()-interval '1 second'"
        } else {
            "clock_timestamp()"
        };
        let sql =
            format!("UPDATE invites SET {change}={value} WHERE organization_id=$1 AND id=ANY($2)");
        sqlx::query(&sql)
            .bind(org)
            .bind(&removed)
            .execute(&pool)
            .await
            .unwrap();
        let second = page(&app, org, &owner, Some(cursor)).await;
        assert_eq!(second["invites"].as_array().unwrap().len(), 100);
        let third = page(&app, org, &owner, second["next_cursor"].as_str()).await;
        assert_eq!(third["invites"].as_array().unwrap().len(), 49);
        assert!(third.get("next_cursor").is_none());
        let seen: Vec<_> = second["invites"]
            .as_array()
            .unwrap()
            .iter()
            .chain(third["invites"].as_array().unwrap())
            .map(id)
            .collect();
        assert_eq!(
            seen,
            ids[100..]
                .iter()
                .copied()
                .filter(|i| *i != ids[155])
                .collect::<Vec<_>>()
        );
    }
}

#[fukulow_test::test]
async fn admin_invite_pages_hide_owner_roles_and_cursors_are_scope_bound(pool: sqlx::PgPool) {
    let org = org(&pool).await;
    let other = org_fn(&pool).await;
    let (_, issuer, _, owner) = account(&pool, org, Role::Owner).await;
    let (_, _, _, admin) = account(&pool, org, Role::Admin).await;
    let (_, _, _, other_owner) = account(&pool, other, Role::Owner).await;
    let app = crate::app(AppState::for_test(pool.clone()).await);
    seed(&pool, org, issuer, 500, true).await;
    let expected: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM invites WHERE organization_id=$1 AND role<>'owner' ORDER BY created_at,id",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut cursor = None;
    let mut seen = vec![];
    for size in [100, 100, 50] {
        let p = page(&app, org, &admin, cursor.as_deref()).await;
        let rows = p["invites"].as_array().unwrap();
        assert_eq!(rows.len(), size);
        assert!(rows.iter().all(|r| r["role"] != "owner"));
        seen.extend(rows.iter().map(id));
        cursor = p.get("next_cursor").map(|c| c.as_str().unwrap().to_owned());
        assert_eq!(cursor.is_some(), size == 100);
    }
    assert_eq!(seen, expected);
    let owner_page = page(&app, org, &owner, None).await;
    let admin_page = page(&app, org, &admin, None).await;
    for (target_org, token, cursor) in [
        (org, &admin, owner_page["next_cursor"].as_str().unwrap()),
        (org, &owner, admin_page["next_cursor"].as_str().unwrap()),
        (
            other,
            &other_owner,
            owner_page["next_cursor"].as_str().unwrap(),
        ),
        (org, &owner, "malformed"),
        (org, &owner, ""),
    ] {
        let before = snapshot(&pool).await;
        let r = req(
            &app,
            "GET",
            &format!("{}?cursor={cursor}", path(target_org)),
            Some(token),
            Value::Null,
        )
        .await;
        denied(&pool, r, &before, StatusCode::BAD_REQUEST, "invalid input").await;
    }
    let before = snapshot(&pool).await;
    let r = req(
        &app,
        "GET",
        &format!("{}?cursor={}", path(org), Uuid::new_v4()),
        Some(&owner),
        Value::Null,
    )
    .await;
    denied(&pool, r, &before, StatusCode::BAD_REQUEST, "invalid input").await;
    // An actual Role change invalidates a previously issued continuation, too.
    let (_, actor, _, token) = account(&pool, org, Role::Owner).await;
    let p = page(&app, org, &token, None).await;
    sqlx::query("UPDATE users SET role='admin' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(actor)
        .execute(&pool)
        .await
        .unwrap();
    let before = snapshot(&pool).await;
    let r = req(
        &app,
        "GET",
        &format!(
            "{}?cursor={}",
            path(org),
            p["next_cursor"].as_str().unwrap()
        ),
        Some(&token),
        Value::Null,
    )
    .await;
    denied(&pool, r, &before, StatusCode::BAD_REQUEST, "invalid input").await;
}
