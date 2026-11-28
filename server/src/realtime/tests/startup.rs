use super::*;
use crate::channels::tests::body;

async fn startup(f: &Fixture, token: &str, channel: Option<Uuid>) -> Response {
    let mut path = format!("/api/v1/orgs/{}/startup", f.organization);
    if let Some(channel) = channel {
        path.push_str(&format!("?channel_id={channel}"));
    }
    request(&f.app, "GET", &path, token, Value::Null).await
}

async fn assert_startup_error(response: Response, status: StatusCode, error: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(body(response).await, json!({"error":error}));
}

async fn assert_channel_denial(f: &Fixture, token: &str, channel: Uuid) {
    assert_startup_error(
        startup(f, token, Some(channel)).await,
        StatusCode::NOT_FOUND,
        "channel not found",
    )
    .await;
    assert_startup_error(
        request(
            &f.app,
            "GET",
            &format!("/api/v1/channels/{channel}/timeline"),
            token,
            Value::Null,
        )
        .await,
        StatusCode::NOT_FOUND,
        "channel not found",
    )
    .await;
}

#[fukulow_test::test]
async fn startup_matches_individual_reads(pool: PgPool) {
    let f = fixture(&pool).await;
    let (other, other_token) = member(&pool, f.organization).await;
    let main = send(&f, &other_token, f.channel, Uuid::new_v4(), "main").await;
    let topic = request(
        &f.app,
        "POST",
        &format!("/api/v1/channels/{}/messages", f.channel),
        &f.token,
        json!({"client_message_id":Uuid::new_v4(),"body":"Topic payload","topic_name":"Release"}),
    )
    .await;
    assert_eq!(topic.status(), StatusCode::CREATED);
    let hidden = channel(&pool, f.organization, other, true).await;
    let hidden_message = send(&f, &other_token, hidden, Uuid::new_v4(), "hidden").await;
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(other)
        .execute(&pool)
        .await
        .unwrap();

    let response = startup(&f, &f.token, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let snapshot = body(response).await;
    let channels = request(&f.app, "GET", "/api/v1/channels", &f.token, Value::Null).await;
    let timeline = request(
        &f.app,
        "GET",
        &format!("/api/v1/channels/{}/timeline", f.channel),
        &f.token,
        Value::Null,
    )
    .await;
    let authors = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/message-authors", f.organization),
        &f.token,
        json!({"ids":[other, f.member, Uuid::new_v4()]}),
    )
    .await;
    for response in [&channels, &timeline, &authors] {
        assert_eq!(response.status(), StatusCode::OK);
    }
    assert_eq!(snapshot["channel_list"], body(channels).await);
    assert_eq!(
        snapshot["channel_list"]["channels"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(snapshot["timeline"]["channel_id"], json!(f.channel));
    assert_eq!(snapshot["timeline"]["page"], body(timeline).await);
    assert_eq!(snapshot["timeline"]["page"]["items"][0]["message"], main);
    assert_eq!(
        snapshot["timeline"]["page"]["items"][1]["topic"]["latest_message"],
        body(topic).await
    );
    assert_eq!(snapshot["timeline"]["authors"], body(authors).await);
    assert!(
        snapshot["timeline"]["authors"]["identities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|author| author["id"] == json!(other) && author["deactivated"] == true)
    );
    assert!(
        !snapshot
            .to_string()
            .contains(hidden_message["id"].as_str().unwrap())
    );
}

#[fukulow_test::test]
async fn startup_empty_selection(pool: PgPool) {
    let f = fixture(&pool).await;
    let org = organization(&pool).await;
    let (_, viewer) = member(&pool, org).await;
    let response = request(
        &f.app,
        "GET",
        &format!("/api/v1/orgs/{org}/startup"),
        &viewer,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot = body(response).await;
    assert_eq!(snapshot["channel_list"]["channels"], json!([]));
    assert!(snapshot["timeline"].is_null());
}

#[fukulow_test::test]
async fn startup_denies_private_nonmember(pool: PgPool) {
    let f = fixture(&pool).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let (_, viewer) = member(&pool, f.organization).await;
    let secret = post(&f, private).await;
    assert_channel_denial(&f, &viewer, private).await;
    let control = startup(&f, &f.token, Some(private)).await;
    assert_eq!(control.status(), StatusCode::OK);
    assert_eq!(
        body(control).await["timeline"]["page"]["items"][0]["message"],
        secret
    );
}

#[fukulow_test::test]
async fn startup_denies_revoked_private_grant(pool: PgPool) {
    let f = fixture(&pool).await;
    let (viewer, token) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, viewer, true).await;
    assert_eq!(
        startup(&f, &token, Some(private)).await.status(),
        StatusCode::OK
    );
    let removed = sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(f.organization)
    .bind(private)
    .bind(viewer)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(removed.rows_affected(), 1);
    assert_channel_denial(&f, &token, private).await;
}

#[fukulow_test::test]
async fn startup_denies_stale_private_grant_after_reactivation(pool: PgPool) {
    let f = fixture(&pool).await;
    let (viewer, token) = member(&pool, f.organization).await;
    let private = channel(&pool, f.organization, viewer, true).await;
    assert_eq!(
        startup(&f, &token, Some(private)).await.status(),
        StatusCode::OK
    );
    for deactivate in [true, false] {
        sqlx::query("UPDATE users SET deactivated_at=CASE WHEN $3 THEN now() END WHERE organization_id=$1 AND id=$2")
            .bind(f.organization)
            .bind(viewer)
            .bind(deactivate)
            .execute(&pool)
            .await
            .unwrap();
    }
    assert_channel_denial(&f, &token, private).await;
    assert_eq!(
        startup(&f, &token, Some(f.channel)).await.status(),
        StatusCode::OK
    );
}

#[fukulow_test::test]
async fn startup_denies_ungranted_guest(pool: PgPool) {
    let f = fixture(&pool).await;
    let (guest, token) = member(&pool, f.organization).await;
    sqlx::query("UPDATE users SET role='guest' WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(guest)
        .execute(&pool)
        .await
        .unwrap();
    assert_channel_denial(&f, &token, f.channel).await;
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(f.organization)
    .bind(f.channel)
    .bind(guest)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        startup(&f, &token, Some(f.channel)).await.status(),
        StatusCode::OK
    );
}

async fn open_dm(f: &Fixture, peer: Uuid) -> Uuid {
    let opened = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/dms", f.organization),
        &f.token,
        json!({"member_id":peer}),
    )
    .await;
    assert_eq!(opened.status(), StatusCode::CREATED);
    serde_json::from_value(body(opened).await["id"].clone()).unwrap()
}

#[fukulow_test::test]
async fn startup_denies_dm_nonparticipant(pool: PgPool) {
    let f = fixture(&pool).await;
    let (peer, peer_token) = member(&pool, f.organization).await;
    let (_, viewer) = member(&pool, f.organization).await;
    let dm = open_dm(&f, peer).await;
    let message = post(&f, dm).await;
    assert_channel_denial(&f, &viewer, dm).await;
    let control = startup(&f, &peer_token, Some(dm)).await;
    assert_eq!(control.status(), StatusCode::OK);
    let snapshot = body(control).await;
    assert_eq!(snapshot["timeline"]["page"]["items"][0]["message"], message);
    assert_eq!(snapshot["timeline"]["authors"]["identities"], json!([]));
}

#[fukulow_test::test]
async fn startup_denies_lapsed_dm_grant(pool: PgPool) {
    let f = fixture(&pool).await;
    let (peer, token) = member(&pool, f.organization).await;
    let dm = open_dm(&f, peer).await;
    assert_eq!(startup(&f, &token, Some(dm)).await.status(), StatusCode::OK);
    for deactivate in [true, false] {
        sqlx::query("UPDATE users SET deactivated_at=CASE WHEN $3 THEN now() END WHERE organization_id=$1 AND id=$2")
            .bind(f.organization).bind(peer).bind(deactivate).execute(&pool).await.unwrap();
    }
    assert_channel_denial(&f, &token, dm).await;
    assert_eq!(
        startup(&f, &f.token, Some(dm)).await.status(),
        StatusCode::OK
    );
}

#[fukulow_test::test]
async fn startup_denies_other_organization(pool: PgPool) {
    let f = fixture(&pool).await;
    let foreign = organization(&pool).await;
    let (other, token) = member(&pool, foreign).await;
    let foreign_channel = channel(&pool, foreign, other, false).await;
    assert_startup_error(
        startup(&f, &token, None).await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
    assert_channel_denial(&f, &f.token, foreign_channel).await;
    assert_channel_denial(&f, &f.token, Uuid::new_v4()).await;
    assert_eq!(
        startup(&f, &f.token, Some(f.channel)).await.status(),
        StatusCode::OK
    );
}

#[fukulow_test::test]
async fn startup_denies_lost_membership(pool: PgPool) {
    let f = fixture(&pool).await;
    let (viewer, token) = member(&pool, f.organization).await;
    assert_eq!(
        startup(&f, &token, Some(f.channel)).await.status(),
        StatusCode::OK
    );
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(f.organization)
        .bind(viewer)
        .execute(&pool)
        .await
        .unwrap();
    assert_startup_error(
        startup(&f, &token, Some(f.channel)).await,
        StatusCode::NOT_FOUND,
        "organization_unavailable",
    )
    .await;
}

#[fukulow_test::test]
async fn startup_denies_ended_session(pool: PgPool) {
    let f = fixture(&pool).await;
    let (_, token) = member(&pool, f.organization).await;
    assert_eq!(startup(&f, &token, None).await.status(), StatusCode::OK);
    let ended = request(&f.app, "DELETE", "/api/v1/session", &token, Value::Null).await;
    assert_eq!(ended.status(), StatusCode::NO_CONTENT);
    assert_startup_error(
        startup(&f, &token, None).await,
        StatusCode::UNAUTHORIZED,
        "invalid credentials",
    )
    .await;
    assert_eq!(startup(&f, &f.token, None).await.status(), StatusCode::OK);
}

#[fukulow_test::test]
async fn startup_watermark_replays_later_message(pool: PgPool) {
    let f = fixture(&pool).await;
    let first = post(&f, f.channel).await;
    let response = startup(&f, &f.token, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot = body(response).await;
    let page = &snapshot["timeline"]["page"];
    assert_eq!(page["items"][0]["message"], first);
    assert_eq!(page["as_of_seq"], first["created_seq"]);

    let second = send(&f, &f.token, f.channel, Uuid::new_v4(), "after snapshot").await;
    let mut client = f.server.connect(&f.token).await;
    control(
        &mut client,
        ClientMessage::Subscribe {
            history_generation: Some(
                serde_json::from_value(page["history_generation"].clone()).unwrap(),
            ),
            channel_id: f.channel,
            after_seq: page["as_of_seq"].as_i64().unwrap(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        event(&mut client).await,
        json!({"type":"message","kind":"create","seq":second["created_seq"],"message":second})
    );
    ready(
        &mut client,
        f.channel,
        second["created_seq"].as_i64().unwrap(),
    )
    .await;
}
