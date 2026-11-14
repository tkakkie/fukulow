use super::*;

async fn assert_conflict(response: Response) {
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(
        body(response).await,
        json!({"error": "channel name already exists"})
    );
}

#[fukulow_test::test]
async fn channel_names_are_unique_across_case_and_visibility(pool: PgPool) {
    let app = router(&pool).await;
    let organization_id = organization(&pool).await;
    let creator = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    let other = member(&pool, organization_id, Uuid::new_v4(), "member").await;

    for (index, (first, duplicate)) in [
        ("public", "public"),
        ("public", "private"),
        ("private", "public"),
        ("private", "private"),
    ]
    .into_iter()
    .enumerate()
    {
        let name = format!("Channel {index}");
        create(&app, &creator, &name, first).await;
        // Even a non-member cannot create a duplicate of a private Channel.
        for name in [name.clone(), name.to_ascii_uppercase()] {
            assert_conflict(
                request(
                    &app,
                    "POST",
                    "/api/v1/channels",
                    &other,
                    json!({"name": name, "visibility": duplicate}),
                )
                .await,
            )
            .await;
        }
    }
    assert_eq!(
        list(&app, &creator).await["channels"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    assert_eq!(
        list(&app, &other).await["channels"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let memberships: i64 =
        sqlx::query_scalar("SELECT count(*) FROM channel_members WHERE organization_id = $1")
            .bind(organization_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(memberships, 2);
}

#[fukulow_test::test]
async fn channel_name_uniqueness_is_scoped_to_organization(pool: PgPool) {
    let app = router(&pool).await;
    for visibility in ["public", "private"] {
        let organization_id = organization(&pool).await;
        let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
        let channel = create(&app, &token, "Shared", visibility).await;
        assert_eq!(
            list(&app, &token).await,
            json!({"channels": [unread_channel(&channel)]})
        );
    }
}

#[fukulow_test::test]
async fn channel_name_comparison_and_order_use_ascii_case_folding(pool: PgPool) {
    let app = router(&pool).await;
    let organization_id = organization(&pool).await;
    let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    for (index, name) in ["zebra", "Banana", "apple", "ZULU", "Apricot", "ä", "Ä"]
        .into_iter()
        .enumerate()
    {
        let visibility = if index % 2 == 0 { "public" } else { "private" };
        create(&app, &token, name, visibility).await;
    }
    assert_conflict(
        request(
            &app,
            "POST",
            "/api/v1/channels",
            &token,
            json!({"name": "APPLE", "visibility": "private"}),
        )
        .await,
    )
    .await;
    let listed = list(&app, &token).await;
    let names: Vec<_> = listed["channels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|channel| channel["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["apple", "Apricot", "Banana", "zebra", "ZULU", "Ä", "ä"]
    );
}

#[fukulow_test::test]
async fn concurrent_duplicate_channel_creates_leave_one_channel(pool: PgPool) {
    let app = router(&pool).await;
    let organization_id = organization(&pool).await;
    let token = member(&pool, organization_id, Uuid::new_v4(), "member").await;
    // All contenders create private Channels so the surviving membership is
    // checked as well as the unique Channel, including case-only duplicates.
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(8));
    let mut tasks = Vec::new();
    for index in 0..8 {
        let app = app.clone();
        let token = token.clone();
        let barrier = barrier.clone();
        tasks.push(tokio::spawn(async move {
            barrier.wait().await;
            request(
                &app,
                "POST",
                "/api/v1/channels",
                &token,
                json!({
                    "name": if index % 2 == 0 { "Concurrent" } else { "CONCURRENT" },
                    "visibility": "private",
                }),
            )
            .await
        }));
    }
    let mut created = Vec::new();
    let mut conflicts = 0;
    for task in tasks {
        let response = task.await.unwrap();
        if response.status() == StatusCode::CREATED {
            created.push(body(response).await);
        } else {
            assert_conflict(response).await;
            conflicts += 1;
        }
    }
    assert_eq!(created.len(), 1);
    assert_eq!(conflicts, 7);
    assert_eq!(
        list(&app, &token).await,
        json!({"channels": created.iter().map(unread_channel).collect::<Vec<_>>()})
    );
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM channels WHERE organization_id = $1), \
                (SELECT count(*) FROM channel_members WHERE organization_id = $1)",
    )
    .bind(organization_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(counts, (1, 1));
}

#[fukulow_test::test]
async fn channel_name_migration_rejects_existing_duplicates_without_changing_them(pool: PgPool) {
    let organization_id = organization(&pool).await;
    sqlx::query("DROP INDEX channels_organization_name_unique")
        .execute(&pool)
        .await
        .unwrap();
    let duplicate_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO channels (organization_id, id, name, visibility) \
         VALUES ($1, $2, 'Existing', 'public'), ($1, $3, 'EXISTING', 'private')",
    )
    .bind(organization_id)
    .bind(Uuid::new_v4())
    .bind(duplicate_id)
    .execute(&pool)
    .await
    .unwrap();
    let migration = include_str!("../../../migrations/202611090003_channel_names.sql");
    let error = sqlx::raw_sql(migration).execute(&pool).await.unwrap_err();
    let error = error.as_database_error().unwrap();
    assert!(error.is_unique_violation());
    assert_eq!(
        error.constraint(),
        Some("channels_organization_name_unique")
    );
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM channels WHERE organization_id = $1 ORDER BY name COLLATE \"C\"",
    )
    .bind(organization_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(names, ["EXISTING", "Existing"]);
    // Simulate operator resolution, then the exact same migration succeeds.
    sqlx::query("DELETE FROM channels WHERE organization_id = $1 AND id = $2")
        .bind(organization_id)
        .bind(duplicate_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(migration).execute(&pool).await.unwrap();
}
