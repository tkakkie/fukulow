use super::*;
use crate::auth::{SubscriptionRecheck, SubscriptionScope};

#[sqlx::test]
async fn handlers_and_fanout_require_authenticated_context(pool: PgPool) {
    let pools = crate::test_support::TestPools::new(pool).await;
    let (_, org, sender, channel, token) = fixture(&pools.admin).await;
    let (_, other_org, other_sender, other_channel, other_token) = fixture(&pools.admin).await;
    let unjoined_org = organization(&pools.admin).await;
    // One Account belongs to both Organizations; /me must not pick a fake tenant.
    let account: Uuid =
        sqlx::query_scalar("SELECT account_id FROM users WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(sender)
            .fetch_one(&pools.admin)
            .await
            .unwrap();
    sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) VALUES ($1,$2,$3,'Shared Account','member')")
        .bind(other_org).bind(Uuid::new_v4()).bind(account).execute(&pools.admin).await.unwrap();
    crate::database::tests::context::context_policies(&pools.admin).await;
    let app = router(&pools.app).layer(axum::Extension(axum::extract::ConnectInfo(
        "127.0.0.1:3140".parse::<std::net::SocketAddr>().unwrap(),
    )));
    // Negative controls: the restricted role cannot read or write without context.
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pools.app)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert!(sqlx::query("INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,'unscoped','public')")
        .bind(org).bind(Uuid::new_v4()).execute(&pools.app).await.is_err());
    let message = request(
        &app,
        "POST",
        &format!("/api/v1/channels/{channel}/messages"),
        &token,
        input(Uuid::new_v4(), "context"),
    )
    .await;
    assert_eq!(message.status(), StatusCode::CREATED);
    let message = body(message).await;
    // These requests include the real Auth extractor and retain positive payload controls.
    for (path, field) in [
        (format!("/api/v1/channels/{channel}/messages"), "messages"),
        (format!("/api/v1/channels/{channel}/timeline"), "items"),
    ] {
        let response = request(&app, "GET", &path, &token, json!(null)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await[field].as_array().unwrap().len(), 1);
    }
    assert_eq!(
        super::super::replay_page(&pools.app, org, channel, 0, 1)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        super::super::authorized_replay_page(&pools.app, org, (sender, 0), channel, 0, 1)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        channels::member_access(&pools.app, org, channel, &[(sender, 0), (other_sender, 0)])
            .await
            .unwrap(),
        vec![(sender, 0, true)]
    );
    let denied = request(
        &app,
        "GET",
        &format!("/api/v1/orgs/{unjoined_org}/channels/{other_channel}/messages"),
        &token,
        json!(null),
    )
    .await;
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);
    // Interleaved Organizations must return subscription checks in input order.
    let changes = channels::AccessChanges::default();
    let first = changes
        .subscribe(&pools.app, org, (sender, 0), channel)
        .await
        .unwrap()
        .unwrap();
    let second = changes
        .subscribe(&pools.app, other_org, (other_sender, 0), other_channel)
        .await
        .unwrap()
        .unwrap();
    changes
        .check(&pools.app, SubscriptionScope::All)
        .await
        .unwrap();
    assert_eq!((first.status(), second.status()), (0, 0));
    sqlx::query(
        "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
    )
    .bind(other_org)
    .bind(other_sender)
    .execute(&pools.admin)
    .await
    .unwrap();
    changes
        .check(&pools.app, SubscriptionScope::All)
        .await
        .unwrap();
    assert_eq!((first.status(), second.status()), (0, 3));
    // Account identity is global, but only for the authenticated Account.
    use argon2::PasswordHasher;
    let hash = argon2::Argon2::default()
        .hash_password_with_salt(b"context-test-password", &[31; 16])
        .unwrap()
        .to_string();
    sqlx::query("UPDATE accounts SET password_hash=$2 WHERE id=$1")
        .bind(account)
        .bind(hash)
        .execute(&pools.admin)
        .await
        .unwrap();
    let sign_in = request(
        &app,
        "POST",
        "/api/v1/native/session",
        "",
        json!({"email": format!("{account}@example.com"), "password": "context-test-password"}),
    )
    .await;
    assert_eq!(sign_in.status(), StatusCode::OK);
    let signed = body(sign_in).await;
    let mut expected = vec![org.to_string(), other_org.to_string()];
    expected.sort();
    let listed: Vec<_> = signed["identity"]["organizations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["organization_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(listed, expected);
    let me = request(&app, "GET", "/api/v1/me", &token, json!(null)).await;
    assert_eq!(me.status(), StatusCode::OK);
    let me = body(me).await;
    assert_eq!(me["account"]["id"], account.to_string());
    assert_eq!(me["organizations"].as_array().unwrap().len(), 2);
    // Neither a previous Organization nor a different Account may leak on reuse.
    let me = request(&app, "GET", "/api/v1/me", &other_token, json!(null)).await;
    assert_eq!(me.status(), StatusCode::OK);
    assert!(
        body(me).await["organizations"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(message["seq"], 1);
    pools.app.close().await;
}
