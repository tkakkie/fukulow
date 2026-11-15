use super::*;

async fn denied_target(pool: PgPool, case: &str) {
    let (app, org, sender, channel, author) = fixture(&pool).await;
    let private = !matches!(
        case,
        "guest_public" | "stale_guest_public" | "foreign" | "unknown" | "inactive"
    );
    let target = Uuid::new_v4();
    let good = Uuid::new_v4();
    let good_token = member(&pool, org, good).await;
    let target_token = if case == "foreign" {
        let other = organization(&pool).await;
        Some(member(&pool, other, target).await)
    } else if case != "unknown" {
        Some(member(&pool, org, target).await)
    } else {
        None
    };
    if private {
        grant(&pool, org, channel, sender).await;
        grant(&pool, org, channel, good).await;
        sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
    }
    let role = match case {
        "private_owner" => "owner",
        "private_admin" => "admin",
        "guest_public" | "guest_private" | "stale_guest_public" => "guest",
        _ => "member",
    };
    // Match the denied Role in the authorized control, including granted
    // private Owner/Admin and public/private Guest targets.
    grant(&pool, org, channel, good).await;
    sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(good)
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    if !matches!(case, "unknown" | "foreign") {
        sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(target)
            .bind(role)
            .execute(&pool)
            .await
            .unwrap();
    }
    if case.starts_with("stale") {
        grant(&pool, org, channel, target).await;
        sqlx::query(
            "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(target)
            .execute(&pool)
            .await
            .unwrap();
    } else if case == "inactive" {
        sqlx::query(
            "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    }
    let text = format!("{} {} {}", token(target), token(good), token(target));
    let key = Uuid::new_v4();
    let accepted = sent(&app, &author, channel, input(key, &text)).await;
    assert_eq!(
        accepted["mentions"],
        json!([{"member_id":good,"name":"Member"}]),
        "{case}"
    );
    assert_eq!(accepted["body"], text);
    assert_eq!(mention_rows(&pool, org).await, 1);
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM message_mentions WHERE organization_id=$1 AND member_id=$2",
    )
    .bind(org)
    .bind(target)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows, 0);
    if let Some(token) = target_token {
        let response = request(&app, "GET", "/api/v1/channels", &token, Value::Null).await;
        if case == "inactive" {
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                body(response).await,
                json!({"error":"organization_unavailable"})
            );
        } else {
            assert_eq!(response.status(), StatusCode::OK);
            let list = body(response).await;
            assert!(
                list["channels"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|c| c["id"] != channel.to_string())
            );
        }
    }
    let good_counts = counts(&app, &good_token).await;
    assert_eq!(good_counts["channels"][0]["main_mention_unread_count"], 1);
    assert_eq!(good_counts["channels"][0]["mention_unread_count"], 1);
    // Every denial has ordinary authorized delivery and an accepted/counting
    // control. No identity is resolved from the rejected token on any read.
    let history = list(&app, &good_token, channel, "?after_seq=0").await;
    assert_eq!(history["messages"][0], accepted);
    let projected = projection(&app, &good_token, channel, "timeline").await;
    assert_eq!(projected["items"][0]["message"], accepted);
    let app_pool = crate::test_app_pool(pool.clone()).await;
    let replay = authorized_replay_page(&app_pool, org, (good, 0), channel, 0, 1)
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(&replay[0]).unwrap(), accepted);
    // Later access must never turn the rejected text into a Mention on retries,
    // history, projections or replay. The original accepted subset is final.
    if !matches!(case, "foreign" | "unknown" | "private_owner") {
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(target)
            .execute(&pool)
            .await
            .unwrap();
        grant(&pool, org, channel, target).await;
        assert_eq!(
            sent(&app, &author, channel, input(key, &text)).await,
            accepted
        );
        assert_eq!(
            list(&app, &author, channel, "").await["messages"][0],
            accepted
        );
        assert_eq!(
            projection(&app, &author, channel, "timeline").await["items"][0]["message"],
            accepted
        );
        let replay = authorized_replay_page(&app_pool, org, (sender, 0), channel, 0, 1)
            .await
            .unwrap();
        assert_eq!(serde_json::to_value(&replay[0]).unwrap(), accepted);
    }
}

#[fukulow_test::test]
async fn mention_denies_private_owner_without_grant(pool: PgPool) {
    denied_target(pool, "private_owner").await;
}
#[fukulow_test::test]
async fn mention_denies_private_admin_without_grant(pool: PgPool) {
    denied_target(pool, "private_admin").await;
}
#[fukulow_test::test]
async fn mention_denies_private_member_without_grant(pool: PgPool) {
    denied_target(pool, "private_member").await;
}
#[fukulow_test::test]
async fn mention_denies_guest_without_public_grant(pool: PgPool) {
    denied_target(pool, "guest_public").await;
}
#[fukulow_test::test]
async fn mention_denies_guest_without_private_grant(pool: PgPool) {
    denied_target(pool, "guest_private").await;
}
#[fukulow_test::test]
async fn mention_denies_foreign_target(pool: PgPool) {
    denied_target(pool, "foreign").await;
}
#[fukulow_test::test]
async fn mention_denies_nonexistent_target(pool: PgPool) {
    denied_target(pool, "unknown").await;
}
#[fukulow_test::test]
async fn mention_denies_inactive_target(pool: PgPool) {
    denied_target(pool, "inactive").await;
}
#[fukulow_test::test]
async fn mention_denies_stale_private_grant(pool: PgPool) {
    denied_target(pool, "stale_private").await;
}
#[fukulow_test::test]
async fn mention_denies_stale_guest_public_grant(pool: PgPool) {
    denied_target(pool, "stale_guest_public").await;
}

#[fukulow_test::test]
async fn mention_public_non_guest_stale_redundant_grant_is_accepted(pool: PgPool) {
    let (app, org, _, channel, author) = fixture(&pool).await;
    let target = Uuid::new_v4();
    member(&pool, org, target).await;
    grant(&pool, org, channel, target).await;
    sqlx::query(
        "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
    )
    .bind(org)
    .bind(target)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sent(
            &app,
            &author,
            channel,
            input(Uuid::new_v4(), &token(target))
        )
        .await["mentions"],
        json!([{"member_id":target,"name":"Member"}])
    );
}
