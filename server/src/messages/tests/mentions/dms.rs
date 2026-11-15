use super::*;

async fn open(app: &Router, author: &str, peer: Uuid, renew: bool) -> Value {
    let r = request(
        app,
        "POST",
        "/api/v1/dms",
        author,
        json!({"member_id":peer,"renew":renew}),
    )
    .await;
    assert!(matches!(r.status(), StatusCode::OK | StatusCode::CREATED));
    body(r).await
}
async fn mark(app: &Router, reader: &str, c: Uuid, seq: i64) {
    let r = request(
        app,
        "PUT",
        &format!("/api/v1/channels/{c}/read"),
        reader,
        json!({"read_seq":seq}),
    )
    .await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body(r).await["read_seq"], seq);
}

async fn counts(app: &Router, reader: &str) -> Value {
    let r = request(app, "GET", "/api/v1/dms", reader, Value::Null).await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
    body(r).await
}

#[fukulow_test::test]
async fn dm_mentions_participant_roles_replies_mark_read_and_renewal_share_batched_counts(
    pool: PgPool,
) {
    for role in ["member", "guest", "owner", "admin"] {
        let (app, org, sender, _, author) = fixture(&pool).await;
        sqlx::query("UPDATE users SET role='owner' WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(sender)
            .execute(&pool)
            .await
            .unwrap();
        let peer = Uuid::new_v4();
        let reader = member(&pool, org, peer).await;
        sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(peer)
            .bind(role)
            .execute(&pool)
            .await
            .unwrap();
        let dm = open(&app, &author, peer, false).await;
        let c = Uuid::parse_str(dm["id"].as_str().unwrap()).unwrap();
        let key = Uuid::new_v4();
        let text = format!("{} {} {}", token(peer), token(sender), token(peer));
        let first = sent(&app, &author, c, input(key, &text)).await;
        assert_eq!(first["mentions"].as_array().unwrap().len(), 2);
        assert_eq!(first["body"], text);
        assert_eq!(
            counts(&app, &reader).await["dms"][0]["mention_unread_count"],
            1
        );
        assert_eq!(
            counts(&app, &author).await["dms"][0]["mention_unread_count"],
            0
        );
        let reply = sent(
            &app,
            &author,
            c,
            json!({"client_message_id":Uuid::new_v4(),"body":token(peer),"reply_to":first["id"]}),
        )
        .await;
        assert!(reply["topic_id"].is_null());
        let page = counts(&app, &reader).await;
        for field in ["main_unread_count", "unread_count", "mention_unread_count"] {
            assert_eq!(page["dms"][0][field], 2);
        }
        let held = request(
            &app,
            "GET",
            &format!("/api/v1/dms?channel_id={c}"),
            &reader,
            Value::Null,
        )
        .await;
        assert_eq!(body(held).await, page);
        assert_eq!(
            open(&app, &author, peer, false).await["mention_unread_count"],
            0
        );
        let history = list(&app, &reader, c, "").await;
        assert_eq!(history["messages"][0], first);
        assert_eq!(history["messages"][1], reply);
        assert_eq!(
            projection(&app, &reader, c, "timeline").await["items"][0]["message"],
            first
        );
        mark(&app, &reader, c, 2).await;
        assert_eq!(
            counts(&app, &reader).await["dms"][0]["mention_unread_count"],
            0
        );
        sent(&app, &author, c, input(Uuid::new_v4(), &token(peer))).await;
        sqlx::query(
            "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(peer)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2")
            .bind(org)
            .bind(peer)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(counts(&app, &reader).await["dms"], json!([]));
        open(&app, &author, peer, true).await;
        assert_eq!(
            counts(&app, &reader).await["dms"][0]["mention_unread_count"],
            0
        );
        assert_eq!(
            sent(&app, &author, c, input(key, &text)).await["mentions"],
            first["mentions"]
        );
        assert_eq!(
            counts(&app, &reader).await["dms"][0]["mention_unread_count"],
            0
        );
    }
}

async fn denied_target(pool: PgPool, case: &str) {
    let (app, org, _, _, author) = fixture(&pool).await;
    let good = Uuid::new_v4();
    let reader = member(&pool, org, good).await;
    let target = Uuid::new_v4();
    let target_org = if case == "foreign" {
        organization(&pool).await
    } else {
        org
    };
    let denied = member(&pool, target_org, target).await;
    let role = match case {
        "owner" => "owner",
        "admin" => "admin",
        "guest" => "guest",
        _ => "member",
    };
    sqlx::query("UPDATE users SET role=$3 WHERE organization_id=$1 AND id=ANY($2)")
        .bind(org)
        .bind([good, target])
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    if case == "inactive" {
        sqlx::query(
            "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(target)
        .execute(&pool)
        .await
        .unwrap();
    }
    let dm = open(&app, &author, good, false).await;
    let c = Uuid::parse_str(dm["id"].as_str().unwrap()).unwrap();
    let text = format!("{} {} {}", token(target), token(good), token(target));
    let key = Uuid::new_v4();
    let m = sent(&app, &author, c, input(key, &text)).await;
    assert_eq!(m["body"], text);
    assert_eq!(m["mentions"], json!([{"member_id":good,"name":"Member"}]));
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
    assert_eq!(
        counts(&app, &reader).await["dms"][0]["mention_unread_count"],
        1
    );
    let denied_counts = request(&app, "GET", "/api/v1/dms", &denied, Value::Null).await;
    if case == "inactive" {
        assert_eq!(denied_counts.status(), StatusCode::NOT_FOUND);
    } else {
        assert_eq!(body(denied_counts).await["dms"], json!([]));
    }
    assert_eq!(list(&app, &reader, c, "").await["messages"][0], m);
    assert_eq!(
        projection(&app, &reader, c, "timeline").await["items"][0]["message"],
        m
    );
    assert_eq!(sent(&app, &author, c, input(key, &text)).await, m);
    let app_pool = crate::test_support::TestPools::new(pool.clone()).await.app;
    let replay = authorized_replay_page(&app_pool, org, (good, 0), c, 0, 1)
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(&replay[0]).unwrap(), m);
    mark(&app, &reader, c, 1).await;
    assert_eq!(
        counts(&app, &reader).await["dms"][0]["mention_unread_count"],
        0
    );
}
#[fukulow_test::test]
async fn dm_mention_denies_nonparticipant_member(pool: PgPool) {
    denied_target(pool, "member").await;
}
#[fukulow_test::test]
async fn dm_mention_denies_nonparticipant_owner(pool: PgPool) {
    denied_target(pool, "owner").await;
}
#[fukulow_test::test]
async fn dm_mention_denies_nonparticipant_admin(pool: PgPool) {
    denied_target(pool, "admin").await;
}
#[fukulow_test::test]
async fn dm_mention_denies_guest_without_grant(pool: PgPool) {
    denied_target(pool, "guest").await;
}
#[fukulow_test::test]
async fn dm_mention_denies_other_organization(pool: PgPool) {
    denied_target(pool, "foreign").await;
}
#[fukulow_test::test]
async fn dm_mention_denies_inactive_member(pool: PgPool) {
    denied_target(pool, "inactive").await;
}

#[fukulow_test::test]
async fn dm_mention_lapsed_peer_refuses_new_send_but_canonical_retry_keeps_set(pool: PgPool) {
    let (app, org, _, _, author) = fixture(&pool).await;
    let peer = Uuid::new_v4();
    let reader = member(&pool, org, peer).await;
    let d = open(&app, &author, peer, false).await;
    let c = Uuid::parse_str(d["id"].as_str().unwrap()).unwrap();
    let key = Uuid::new_v4();
    let text = token(peer);
    let m = sent(&app, &author, c, input(key, &text)).await;
    assert_eq!(m["mentions"], json!([{"member_id":peer,"name":"Member"}]));
    assert_eq!(
        counts(&app, &reader).await["dms"][0]["mention_unread_count"],
        1
    );
    for inactive in [true, false] {
        sqlx::query("UPDATE users SET deactivated_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE organization_id=$1 AND id=$2")
            .bind(org).bind(peer).bind(inactive).execute(&pool).await.unwrap();
        let refused = send(&app, &author, c, input(Uuid::new_v4(), &text)).await;
        assert_eq!(refused.status(), StatusCode::CONFLICT);
        assert_eq!(
            body(refused).await,
            json!({"error":if inactive {"dm_peer_deactivated"} else {"dm_peer_access_lapsed"}})
        );
        assert_eq!(mention_rows(&pool, org).await, 1);
        assert_eq!(list(&app, &author, c, "").await["messages"], json!([m]));
        assert_eq!(sent(&app, &author, c, input(key, &text)).await, m);
    }
    assert_eq!(counts(&app, &reader).await["dms"], json!([]));
    open(&app, &author, peer, true).await;
    assert_eq!(
        counts(&app, &reader).await["dms"][0]["mention_unread_count"],
        0
    );
}
