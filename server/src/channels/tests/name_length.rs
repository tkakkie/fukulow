use super::*;

#[sqlx::test]
async fn channel_name_length_boundaries_count_unicode_scalars(pool: PgPool) {
    let app = router(&pool);
    for visibility in ["public", "private"] {
        let organization_id = organization(&pool).await;
        let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
        for (index, name) in [
            "a".repeat(128),
            "界".repeat(128),
            "😀".repeat(128),
            "e\u{301}".repeat(64),
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(name.chars().count(), 128);
            create(&app, &token, &name, visibility).await;
            let before = list(&app, &token).await;
            let response = request(
                &app,
                "POST",
                "/api/v1/channels",
                &token,
                json!({"name": format!("{name}x"), "visibility": visibility}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(body(response).await, json!({"error": "invalid input"}));
            assert_eq!(list(&app, &token).await, before);
            let counts: (i64, i64) = sqlx::query_as(
                "SELECT (SELECT count(*) FROM channels WHERE organization_id = $1), \
                        (SELECT count(*) FROM channel_members WHERE organization_id = $1)",
            )
            .bind(organization_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            let created = (index + 1) as i64;
            assert_eq!(
                counts,
                (created, if visibility == "private" { created } else { 0 })
            );
        }
    }
}

#[sqlx::test]
async fn oversized_channel_name_is_rejected_before_opening_transaction(pool: PgPool) {
    let organization_id = organization(&pool).await;
    let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    let state = AppState::for_test(pool.clone());
    let auth = extract_auth(state.clone(), &token).await;
    // Auth may read the session; semantic validation must precede even BEGIN.
    pool.close().await;
    let response = create_channel(
        State(state),
        auth,
        ApiJson(CreateChannelRequest {
            name: "😀".repeat(129),
            visibility: ChannelVisibility::Private,
        }),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(body(response).await, json!({"error": "invalid input"}));
}

#[sqlx::test]
async fn channel_name_length_preserves_empty_names(pool: PgPool) {
    let app = router(&pool);
    let organization_id = organization(&pool).await;
    let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    for name in [""] {
        create(&app, &token, name, "public").await;
    }
}

#[sqlx::test]
async fn channel_name_length_check_rejects_direct_inserts_and_updates(pool: PgPool) {
    let organization_id = organization(&pool).await;
    for scalar in ["a", "界", "😀"] {
        let id = Uuid::new_v4();
        let name = scalar.repeat(128);
        sqlx::query(
            "INSERT INTO channels (organization_id, id, name, visibility) \
             VALUES ($1, $2, $3, 'public')",
        )
        .bind(organization_id)
        .bind(id)
        .bind(&name)
        .execute(&pool)
        .await
        .unwrap();
        let oversized = scalar.repeat(129);
        let insert_error = sqlx::query(
            "INSERT INTO channels (organization_id, id, name, visibility) \
             VALUES ($1, $2, $3, 'private')",
        )
        .bind(organization_id)
        .bind(Uuid::new_v4())
        .bind(&oversized)
        .execute(&pool)
        .await
        .unwrap_err();
        let update_error =
            sqlx::query("UPDATE channels SET name = $3 WHERE organization_id = $1 AND id = $2")
                .bind(organization_id)
                .bind(id)
                .bind(oversized)
                .execute(&pool)
                .await
                .unwrap_err();
        for error in [insert_error, update_error] {
            let error = error.as_database_error().unwrap();
            assert_eq!(error.code().as_deref(), Some("23514"));
            assert_eq!(error.constraint(), Some("channels_name_length"));
        }
        let stored: String =
            sqlx::query_scalar("SELECT name FROM channels WHERE organization_id = $1 AND id = $2")
                .bind(organization_id)
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, name);
    }
}

#[sqlx::test]
async fn channel_name_length_migration_rejects_existing_violators_without_changing_them(
    pool: PgPool,
) {
    let organization_id = organization(&pool).await;
    let member_id = Uuid::new_v4();
    member(&pool, organization_id, member_id, "member").await;
    sqlx::query("ALTER TABLE channels DROP CONSTRAINT channels_name_length")
        .execute(&pool)
        .await
        .unwrap();
    let mut expected = Vec::new();
    for name in [
        "kept".to_owned(),
        "a".repeat(129),
        "界".repeat(129),
        "😀".repeat(129),
    ] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO channels (organization_id, id, name, visibility) \
             VALUES ($1, $2, $3, 'private')",
        )
        .bind(organization_id)
        .bind(id)
        .bind(&name)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO channel_members (organization_id, channel_id, member_id) \
             VALUES ($1, $2, $3)",
        )
        .bind(organization_id)
        .bind(id)
        .bind(member_id)
        .execute(&pool)
        .await
        .unwrap();
        expected.push((id, name, "private".to_owned()));
    }
    expected.sort_by_key(|row| row.0);
    let migration = include_str!("../../../migrations/202611090004_channel_name_length.sql");
    let error = sqlx::raw_sql(migration).execute(&pool).await.unwrap_err();
    let error = error.as_database_error().unwrap();
    assert_eq!(error.code().as_deref(), Some("23514"));
    assert_eq!(error.constraint(), Some("channels_name_length"));
    let stored: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT id, name, visibility FROM channels WHERE organization_id = $1 ORDER BY id",
    )
    .bind(organization_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(stored, expected);
    let memberships: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT channel_id, member_id FROM channel_members WHERE organization_id = $1 ORDER BY channel_id",
    )
    .bind(organization_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        memberships,
        expected
            .iter()
            .map(|row| (row.0, member_id))
            .collect::<Vec<_>>()
    );
}
