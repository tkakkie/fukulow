use super::*;

#[sqlx::test]
async fn public_authorization_skips_membership_sql_but_checks_organization_and_channel(
    pool: PgPool,
) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let creator = Uuid::new_v4();
    let token = member(&pool, org, creator, "member").await;
    let public = create(&app, &token, "Public", "public").await;
    let private = create(&app, &token, "Private", "private").await;
    let public = Uuid::parse_str(public["id"].as_str().unwrap()).unwrap();
    let private = Uuid::parse_str(private["id"].as_str().unwrap()).unwrap();
    let other = organization(&pool).await;
    member(&pool, other, creator, "member").await;
    let nonmember = Uuid::new_v4();
    member(&pool, org, nonmember, "member").await;
    // Public authorization must not execute private-grant checks, even in a combined query.
    sqlx::query("ALTER TABLE channel_members RENAME TO unavailable_channel_members")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION membership_query_forbidden() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private grant query executed'; END $$; CREATE VIEW channel_members AS SELECT * FROM unavailable_channel_members WHERE membership_query_forbidden()")
        .execute(&pool).await.unwrap();
    for reader in [creator, nonmember] {
        assert!(is_visible(&pool, org, (reader, 0), public).await.unwrap() == Some(true));
    }
    assert_eq!(
        visible_members(&pool, org, public, &[(creator, 0), (nonmember, 0)])
            .await
            .unwrap()
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
        [(creator, 0), (nonmember, 0)]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
    );
    for (scope, channel) in [(other, public), (org, Uuid::new_v4())] {
        assert!(
            is_visible(&pool, scope, (creator, 0), channel)
                .await
                .unwrap()
                != Some(true)
        );
        assert!(
            visible_members(&pool, scope, channel, &[(creator, 0)])
                .await
                .unwrap()
                .is_empty()
        );
    }
    // The private paths still require membership SQL, including for the creator.
    assert!(is_visible(&pool, org, (creator, 0), private).await.is_err());
    assert!(
        visible_members(&pool, org, private, &[(creator, 0)])
            .await
            .is_err()
    );
}

#[sqlx::test]
async fn authorization_reads_current_visibility_and_scopes_private_membership(pool: PgPool) {
    let app = router(&pool);
    let org = organization(&pool).await;
    let other = organization(&pool).await;
    let creator = Uuid::new_v4();
    let token = member(&pool, org, creator, "member").await;
    let reader = Uuid::new_v4();
    member(&pool, org, reader, "member").await;
    member(&pool, other, reader, "member").await;
    let channel = create(&app, &token, "Changing", "public").await;
    let channel = Uuid::parse_str(channel["id"].as_str().unwrap()).unwrap();
    // Same ids and a membership in the other Organization must never grant access here.
    sqlx::query("INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $2, 'Other', 'private')")
        .bind(other).bind(channel).execute(&pool).await.unwrap();
    for (scope, id) in [(org, creator), (other, reader)] {
        sqlx::query("INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $2, $3)")
            .bind(scope).bind(channel).bind(id).execute(&pool).await.unwrap();
    }
    for visibility in ["public", "private", "public"] {
        sqlx::query("UPDATE channels SET visibility = $3 WHERE organization_id = $1 AND id = $2")
            .bind(org)
            .bind(channel)
            .bind(visibility)
            .execute(&pool)
            .await
            .unwrap();
        assert!(is_visible(&pool, org, (creator, 0), channel).await.unwrap() == Some(true));
        assert_eq!(
            is_visible(&pool, org, (reader, 0), channel).await.unwrap() == Some(true),
            visibility == "public"
        );
        let allowed = visible_members(&pool, org, channel, &[(creator, 0), (reader, 0)])
            .await
            .unwrap();
        assert!(allowed.contains(&(creator, 0)));
        assert_eq!(allowed.contains(&(reader, 0)), visibility == "public");
        assert!(
            is_visible(&pool, other, (creator, 0), channel)
                .await
                .unwrap()
                != Some(true)
        );
        assert!(
            is_visible(&pool, other, (reader, 0), channel)
                .await
                .unwrap()
                == Some(true)
        );
    }
}
