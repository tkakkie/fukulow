use super::*;

pub(crate) mod baseline;

async fn channels(app: &Router, token: &str) -> Value {
    let response = request(app, "GET", "/api/v1/channels", token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    body(response).await
}

async fn mark(app: &Router, token: &str, channel: Uuid, topic: Option<&str>, seq: i64) -> Value {
    let suffix = topic.map_or_else(|| "read".into(), |t| format!("topics/{t}/read"));
    let response = request(
        app,
        "PUT",
        &format!("/api/v1/channels/{channel}/{suffix}"),
        token,
        json!({"read_seq":seq}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    body(response).await
}

async fn post(app: &Router, token: &str, channel: Uuid, topic: Option<&str>) -> Value {
    sent(
        app,
        token,
        channel,
        json!({"client_message_id":Uuid::new_v4(),"body":"Unread test", "topic_name":topic}),
    )
    .await
}

async fn topics(app: &Router, token: &str, channel: Uuid) -> Value {
    get_projection(app, token, channel, "topics").await
}

async fn get_projection(app: &Router, token: &str, channel: Uuid, suffix: &str) -> Value {
    let response = request(
        app,
        "GET",
        &format!("/api/v1/channels/{channel}/{suffix}"),
        token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    body(response).await
}

#[sqlx::test]
async fn unread_main_timeline_and_topics_are_independent_monotonic_and_exclude_own_sends(
    pool: PgPool,
) {
    let (app, org, _, channel, owner) = fixture(&pool).await;
    let viewer = member(&pool, org, Uuid::new_v4()).await;
    post(&app, &owner, channel, None).await; // 1, other sender main
    let topic = post(&app, &owner, channel, Some("Hidden")).await; // 2
    post(&app, &viewer, channel, None).await; // 3, own
    post(&app, &viewer, channel, Some("Hidden")).await; // 4, own
    post(&app, &owner, channel, Some("Hidden")).await; // 5
    let t = topic["topic_id"].as_str().unwrap();
    let c = channels(&app, &viewer).await;
    assert_eq!(c["channels"][0]["read_seq"], 0);
    assert_eq!(c["channels"][0]["main_unread_count"], 1);
    assert_eq!(c["channels"][0]["unread_count"], 3);
    let ts = topics(&app, &viewer, channel).await;
    assert_eq!(ts["topics"][0]["read_seq"], 0);
    assert_eq!(ts["topics"][0]["unread_count"], 2);
    // Fetching history has no side effects; explicitly viewing/marking the
    // main timeline moves only its position, even beyond hidden Topic Messages.
    get_projection(&app, &viewer, channel, "timeline").await;
    assert_eq!(
        mark(&app, &viewer, channel, None, i64::MAX).await,
        json!({"read_seq":5})
    );
    assert_eq!(topics(&app, &viewer, channel).await, ts);
    let c = channels(&app, &viewer).await;
    assert_eq!(c["channels"][0]["main_unread_count"], 0);
    assert_eq!(c["channels"][0]["unread_count"], 2);
    assert_eq!(mark(&app, &viewer, channel, None, 1).await["read_seq"], 5);
    assert_eq!(
        mark(&app, &viewer, channel, Some(t), 2).await["read_seq"],
        2
    );
    assert_eq!(
        channels(&app, &viewer).await["channels"][0]["unread_count"],
        1
    );
    // Concurrent devices max together, and refetch with a fresh app/controller
    // instance returns the persisted maximum rather than a device-local value.
    let (a, b) = tokio::join!(
        mark(&app, &viewer, channel, Some(t), 5),
        mark(&app, &viewer, channel, Some(t), 1)
    );
    assert_eq!(a["read_seq"], 5);
    assert!(b["read_seq"].as_i64().unwrap() >= 2);
    let fresh = router(&pool);
    assert_eq!(
        topics(&fresh, &viewer, channel).await["topics"][0]["read_seq"],
        5
    );
    assert_eq!(
        channels(&fresh, &viewer).await["channels"][0]["unread_count"],
        0
    );
    assert_eq!(channels(&app, &owner).await["channels"][0]["read_seq"], 0);
    assert_eq!(
        channels(&app, &owner).await["channels"][0]["unread_count"],
        2
    );
    // Topic positions don't move the main position, and sends move neither.
    post(&app, &owner, channel, None).await;
    post(&app, &owner, channel, Some("Hidden")).await;
    mark(&app, &viewer, channel, Some(t), 7).await;
    let c = channels(&app, &viewer).await;
    assert_eq!(c["channels"][0]["read_seq"], 5);
    assert_eq!(c["channels"][0]["main_unread_count"], 1);
    assert_eq!(c["channels"][0]["unread_count"], 1);
}

#[sqlx::test]
async fn unread_new_member_and_regrant_start_at_new_grants_committed_seq(pool: PgPool) {
    let (app, org, owner_id, channel, owner) = fixture(&pool).await;
    post(&app, &owner, channel, None).await;
    let topic = post(&app, &owner, channel, Some("Existing")).await;
    let viewer_id = Uuid::new_v4();
    let viewer = member(&pool, org, viewer_id).await;
    assert_eq!(channels(&app, &viewer).await["channels"][0]["read_seq"], 2);
    assert_eq!(
        topics(&app, &viewer, channel).await["topics"][0]["read_seq"],
        2
    );
    // Lose public access, then grant private access after another committed send.
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(channel)
    .bind(owner_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    post(&app, &owner, channel, None).await;
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(channel)
    .bind(viewer_id)
    .execute(&pool)
    .await
    .unwrap();
    post(&app, &owner, channel, Some("Existing")).await;
    assert_eq!(channels(&app, &viewer).await["channels"][0]["read_seq"], 3);
    assert_eq!(
        channels(&app, &viewer).await["channels"][0]["unread_count"],
        1
    );
    mark(
        &app,
        &viewer,
        channel,
        Some(topic["topic_id"].as_str().unwrap()),
        4,
    )
    .await;
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(org)
    .bind(channel)
    .bind(viewer_id)
    .execute(&pool)
    .await
    .unwrap();
    post(&app, &owner, channel, Some("Existing")).await;
    sqlx::query(
        "INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(channel)
    .bind(viewer_id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(channels(&app, &viewer).await["channels"][0]["read_seq"], 5);
    assert_eq!(
        topics(&app, &viewer, channel).await["topics"][0]["read_seq"],
        5
    );
    assert_eq!(
        channels(&app, &viewer).await["channels"][0]["unread_count"],
        0
    );
    // A future Topic inherits the grant baseline, so its first Message is unread.
    post(&app, &owner, channel, Some("New")).await;
    assert_eq!(
        channels(&app, &viewer).await["channels"][0]["unread_count"],
        1
    );
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(viewer_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(viewer_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(channels(&app, &viewer).await["channels"], json!([]));
    // Re-grant at the active Member revision; historical grants cannot revive it.
    sqlx::query("UPDATE channel_members SET membership_revision=1 WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3").bind(org).bind(channel).bind(viewer_id).execute(&pool).await.unwrap();
    assert_eq!(channels(&app, &viewer).await["channels"][0]["read_seq"], 6);
}

#[sqlx::test(migrations = false)]
async fn unread_migration_initializes_existing_visible_members_and_each_topic(pool: PgPool) {
    let mut paths =
        std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_str().unwrap() < "202611110199_unread.sql")
            .collect::<Vec<_>>();
    paths.sort();
    for path in paths {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    let (app, org, owner_id, channel, owner) = fixture(&pool).await;
    let viewer_id = Uuid::new_v4();
    let viewer = member(&pool, org, viewer_id).await;
    post(&app, &owner, channel, Some("A")).await;
    post(&app, &owner, channel, Some("B")).await;
    post(&app, &owner, channel, None).await;
    let private = Uuid::new_v4();
    super::channel(&pool, org, private, owner_id, true).await;
    post(&app, &owner, private, Some("Private")).await;
    sqlx::raw_sql(include_str!("../../../migrations/202611110199_unread.sql"))
        .execute(&pool)
        .await
        .unwrap();
    let positions: Vec<(Uuid, i64, i64)> = sqlx::query_as("SELECT member_id,initial_seq,read_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 ORDER BY member_id")
        .bind(org).bind(channel).fetch_all(&pool).await.unwrap();
    assert_eq!(positions.len(), 2);
    assert!(
        positions
            .iter()
            .all(|(_, initial, read)| (*initial, *read) == (3, 3))
    );
    let topic_positions: Vec<i64> = sqlx::query_scalar(
        "SELECT read_seq FROM topic_read_positions WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(channel)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(topic_positions, vec![3, 3, 3, 3]);
    let hidden: i64 = sqlx::query_scalar("SELECT count(*) FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(org).bind(private).bind(viewer_id).fetch_one(&pool).await.unwrap();
    assert_eq!(hidden, 0);
    // Validate the historical backfill above before bringing its schema forward
    // for current handlers (which now also project Channel manager rights).
    let mut later =
        std::fs::read_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.file_name().unwrap().to_str().unwrap() > "202611110199_unread.sql")
            .collect::<Vec<_>>();
    later.sort();
    for path in later {
        sqlx::raw_sql(&std::fs::read_to_string(path).unwrap())
            .execute(&pool)
            .await
            .unwrap();
    }
    assert_eq!(
        channels(&app, &viewer).await["channels"][0]["unread_count"],
        0
    );
    post(&app, &owner, channel, Some("A")).await;
    assert_eq!(
        channels(&app, &viewer).await["channels"][0]["unread_count"],
        1
    );
}

mod access;
mod concurrency;
mod denials;
mod measurement;
mod policy;
mod roles;

#[sqlx::test]
async fn unread_public_access_transitions_preserve_continuous_access_and_reset_new_access(
    pool: PgPool,
) {
    let (app, org, owner_id, channel, owner) = fixture(&pool).await;
    let viewer_id = Uuid::new_v4();
    let viewer = member(&pool, org, viewer_id).await;
    let newcomer = member(&pool, org, Uuid::new_v4()).await;
    post(&app, &owner, channel, None).await;
    post(&app, &owner, channel, Some("Existing")).await;
    mark(&app, &viewer, channel, None, 1).await;
    // Adding a redundant private grant while public is not a new access epoch.
    sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ($1,$2,$3),($1,$2,$4)").bind(org).bind(channel).bind(owner_id).bind(viewer_id).execute(&pool).await.unwrap();
    assert_eq!(channels(&app, &viewer).await["channels"][0]["read_seq"], 1);
    sqlx::query("UPDATE channels SET visibility='private' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    post(&app, &owner, channel, Some("Existing")).await;
    assert_eq!(channels(&app, &newcomer).await["channels"], json!([]));
    sqlx::query("UPDATE channels SET visibility='public' WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        channels(&app, &newcomer).await["channels"][0]["read_seq"],
        3
    );
    assert_eq!(
        topics(&app, &newcomer, channel).await["topics"][0]["read_seq"],
        3
    );
    assert_eq!(channels(&app, &viewer).await["channels"][0]["read_seq"], 1);
    assert_eq!(
        topics(&app, &viewer, channel).await["topics"][0]["read_seq"],
        0
    );
    sqlx::query("UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(viewer_id)
        .execute(&pool)
        .await
        .unwrap();
    post(&app, &owner, channel, None).await;
    sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
        .bind(org)
        .bind(viewer_id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(channels(&app, &viewer).await["channels"][0]["read_seq"], 4);
    assert_eq!(
        topics(&app, &viewer, channel).await["topics"][0]["read_seq"],
        4
    );
}

#[sqlx::test]
async fn unread_topic_counts_respect_w_and_current_persisted_positions(pool: PgPool) {
    let (app, org, _, channel, owner) = fixture(&pool).await;
    let viewer = member(&pool, org, Uuid::new_v4()).await;
    let topic = post(&app, &owner, channel, Some("Topic")).await;
    post(&app, &viewer, channel, Some("Topic")).await;
    post(&app, &owner, channel, Some("Topic")).await;
    let before = get_projection(&app, &viewer, channel, "topics?as_of_seq=2").await;
    assert_eq!(before["topics"][0]["unread_count"], 1);
    assert_eq!(
        topics(&app, &viewer, channel).await["topics"][0]["unread_count"],
        2
    );
    let id = topic["topic_id"].as_str().unwrap();
    mark(&app, &viewer, channel, Some(id), 3).await;
    let after = get_projection(&app, &viewer, channel, "topics?as_of_seq=2").await;
    assert_eq!(after["topics"][0]["message_count"], 2);
    assert_eq!(after["topics"][0]["last_seq"], 2);
    assert_eq!(after["topics"][0]["read_seq"], 3);
    assert_eq!(after["topics"][0]["unread_count"], 0);
}
