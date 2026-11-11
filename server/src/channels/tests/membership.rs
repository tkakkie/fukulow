use super::*;

#[sqlx::test]
async fn channel_list_denies_deactivation_after_auth_and_stale_reactivation(pool: PgPool) {
    for reactivate in [false, true] {
        let state = AppState::for_test(pool.clone());
        let app = crate::app(state.clone());
        let organization = organization(&pool).await;
        let id = Uuid::new_v4();
        let token = member(&pool, organization, id, "member").await;
        create(&app, &token, "Public", "public").await;
        create(&app, &token, "Private", "private").await;
        let auth = extract_auth(state.clone(), &token).await;
        sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
            .bind(organization)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        if reactivate {
            sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
                .bind(organization)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }
        let response = visible_list(&state.pool, &auth)
            .await
            .unwrap_err()
            .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            body(response).await,
            json!({"error":"organization_unavailable"})
        );
    }
}

#[sqlx::test]
async fn channel_creation_denies_deactivation_after_auth_without_inserting(pool: PgPool) {
    for reactivate in [false, true] {
        for visibility in [ChannelVisibility::Public, ChannelVisibility::Private] {
            let state = AppState::for_test(pool.clone());
            let organization = organization(&pool).await;
            let id = Uuid::new_v4();
            let token = member(&pool, organization, id, "member").await;
            let auth = extract_auth(state.clone(), &token).await;
            sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
                .bind(organization)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
            if reactivate {
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(organization)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
            }
            let response = create_channel(
                State(state),
                auth,
                ApiJson(CreateChannelRequest {
                    name: "Denied".into(),
                    visibility,
                }),
            )
            .await
            .unwrap_err()
            .into_response();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                body(response).await,
                json!({"error":"organization_unavailable"})
            );
            let channels: i64 =
                sqlx::query_scalar("SELECT count(*) FROM channels WHERE organization_id=$1")
                    .bind(organization)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let grants: i64 =
                sqlx::query_scalar("SELECT count(*) FROM channel_members WHERE organization_id=$1")
                    .bind(organization)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            assert_eq!((channels, grants), (0, 0));
        }
    }
}
