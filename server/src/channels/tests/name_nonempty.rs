use super::*;

const MIGRATION: &str = include_str!("../../../migrations/202611140299_channel_name_nonempty.sql");

async fn restore_old_length_check(pool: &PgPool) {
    sqlx::raw_sql(
        "ALTER TABLE channels DROP CONSTRAINT channels_name_length;
        ALTER TABLE channels ADD CONSTRAINT channels_name_length CHECK (char_length(name) <= 128);",
    )
    .execute(pool)
    .await
    .unwrap();
}

#[fukulow_test::test]
async fn empty_channel_name_aborts_migration_and_preserves_rows_until_operator_correction(
    pool: PgPool,
) {
    restore_old_length_check(&pool).await;
    let org = organization(&pool).await;
    let member_id = Uuid::new_v4();
    member(&pool, org, member_id, "member").await;
    let mut expected = Vec::new();
    for name in ["", "kept"] {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,$3,'private')",
        )
        .bind(org)
        .bind(id)
        .bind(name)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
        )
        .bind(org)
        .bind(id)
        .bind(member_id)
        .execute(&pool)
        .await
        .unwrap();
        expected.push((id, name.to_owned(), "private".to_owned()));
    }
    expected.sort_by_key(|row| row.0);
    let error = sqlx::raw_sql(MIGRATION).execute(&pool).await.unwrap_err();
    let error = error.as_database_error().unwrap();
    assert_eq!(error.code().as_deref(), Some("23514"));
    assert_eq!(error.constraint(), Some("channels_name_length_nonempty"));
    let stored: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT id,name,visibility FROM channels WHERE organization_id=$1 ORDER BY id",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(stored, expected);
    let memberships: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT channel_id,member_id FROM channel_members WHERE organization_id=$1 ORDER BY channel_id")
        .bind(org).fetch_all(&pool).await.unwrap();
    assert_eq!(
        memberships,
        expected
            .iter()
            .map(|row| (row.0, member_id))
            .collect::<Vec<_>>()
    );
    let old_check: String = sqlx::query_scalar(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='channels'::regclass AND conname='channels_name_length'")
        .fetch_one(&pool).await.unwrap();
    assert!(old_check.contains("<= 128"));
    // The operator supplies the replacement; rerunning the same migration succeeds.
    sqlx::query(
        "UPDATE channels SET name='operator corrected' WHERE organization_id=$1 AND name=''",
    )
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(MIGRATION).execute(&pool).await.unwrap();
}

#[fukulow_test::test]
async fn nonempty_channel_name_migration_upgrades_clean_rows_without_changes(pool: PgPool) {
    restore_old_length_check(&pool).await;
    let org = organization(&pool).await;
    let id = Uuid::new_v4();
    let name = "😀".repeat(128);
    sqlx::query(
        "INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,$3,'public')",
    )
    .bind(org)
    .bind(id)
    .bind(&name)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(MIGRATION).execute(&pool).await.unwrap();
    let stored: String =
        sqlx::query_scalar("SELECT name FROM channels WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, name);
}

#[tokio::test]
async fn nul_channel_name_keeps_authentication_precedence() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let app = crate::app(AppState::with_test_pool(pool.clone()));
    pool.close().await;
    for credential in [None, Some("invalid")] {
        let mut request = Request::post(format!("/api/v1/orgs/{}/channels", Uuid::new_v4()))
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = credential {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = app
            .clone()
            .oneshot(
                request
                    .body(Body::from(
                        json!({"name": "a\0b", "visibility": "private"}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            body(response).await,
            json!({"error": "invalid credentials"})
        );
    }
}
