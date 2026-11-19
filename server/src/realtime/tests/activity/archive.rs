use super::*;
use crate::channels::tests::body;

async fn edit(f: &Fixture, channel: Uuid, token: &str, patch: Value) -> StatusCode {
    request(
        &f.app,
        "PATCH",
        &format!("/api/v1/channels/{channel}"),
        token,
        patch,
    )
    .await
    .status()
}

#[fukulow_test::test]
async fn archive_notices_reach_only_current_readers_after_commit(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let (reader_id, reader_token) = member(&pool, f.organization).await;
    let (guest_id, guest_token) = member(&pool, f.organization).await;
    role(&pool, &f, guest_id, "guest").await;
    let (public_guest_id, public_guest_token) = member(&pool, f.organization).await;
    role(&pool, &f, public_guest_id, "guest").await;
    grant(&pool, &f, f.channel, public_guest_id).await;
    grant(&pool, &f, private, reader_id).await;
    grant(&pool, &f, private, guest_id).await;
    let (_, outsider) = member(&pool, f.organization).await;
    let (_, foreign) = member(&pool, organization(&pool).await).await;
    let mut actor = connect(&f, &f.token).await;
    let mut reader = connect(&f, &reader_token).await;
    let mut guest = connect(&f, &guest_token).await;
    let mut public_guest = connect(&f, &public_guest_token).await;
    let mut nonreader = connect(&f, &outsider).await;
    let mut foreign = connect(&f, &foreign).await;
    for patch in [
        json!({"name":"Private renamed"}),
        json!({"archived":true}),
        json!({"archived":false}),
    ] {
        assert_eq!(
            edit(&f, private, &f.token, patch).await,
            StatusCode::NO_CONTENT
        );
        for socket in [&mut actor, &mut reader, &mut guest] {
            assert_eq!(
                notices(&f, socket).await,
                vec![json!({"type":"channel_list_changed"})]
            );
        }
        for socket in [&mut nonreader, &mut public_guest, &mut foreign] {
            assert!(notices(&f, socket).await.is_empty());
        }
    }
    assert_eq!(
        edit(&f, f.channel, &f.token, json!({"archived":true})).await,
        StatusCode::NO_CONTENT
    );
    for socket in [&mut actor, &mut reader, &mut nonreader, &mut public_guest] {
        assert_eq!(
            notices(&f, socket).await,
            vec![json!({"type":"channel_list_changed"})]
        );
    }
    for socket in [&mut guest, &mut foreign] {
        assert!(notices(&f, socket).await.is_empty());
    }

    // Fail at COMMIT after an effective UPDATE. Any attempted no-op UPDATE
    // would also fail, so 204 proves the no-op path performed no row write.
    sqlx::raw_sql(
        "CREATE FUNCTION refuse_metadata_commit() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'rollback metadata change'; END $$;
         CREATE CONSTRAINT TRIGGER refuse_metadata_commit AFTER UPDATE ON channels
           DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_metadata_commit()",
    )
    .execute(&pool)
    .await
    .unwrap();
    for (channel, token, patch, status) in [
        (
            private,
            &f.token,
            json!({"name":"Private renamed"}),
            StatusCode::NO_CONTENT,
        ),
        (
            private,
            &f.token,
            json!({"archived":false}),
            StatusCode::NO_CONTENT,
        ),
        (
            f.channel,
            &f.token,
            json!({"archived":true}),
            StatusCode::NO_CONTENT,
        ),
        (
            f.channel,
            &f.token,
            json!({"name":"Blocked"}),
            StatusCode::CONFLICT,
        ),
        (
            private,
            &guest_token,
            json!({"archived":true}),
            StatusCode::FORBIDDEN,
        ),
        (
            private,
            &outsider,
            json!({"archived":true}),
            StatusCode::NOT_FOUND,
        ),
        (
            private,
            &f.token,
            json!({"archived":true}),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
        (
            private,
            &f.token,
            json!({"name":"Rolled back"}),
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    ] {
        assert_eq!(edit(&f, channel, token, patch).await, status);
    }
    for socket in [
        &mut actor,
        &mut reader,
        &mut guest,
        &mut nonreader,
        &mut public_guest,
        &mut foreign,
    ] {
        assert!(notices(&f, socket).await.is_empty());
    }
    let response = request(
        &f.app,
        "GET",
        &format!("/api/v1/channels/{private}"),
        &f.token,
        Value::Null,
    )
    .await;
    let row = body(response).await;
    assert_eq!(row["name"], "Private renamed");
    assert_eq!(row["archived"], false);
}

async fn read(f: &Fixture, token: &str, path: &str) -> Value {
    let response = request(&f.app, "GET", path, token, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK, "{path}");
    body(response).await
}

#[fukulow_test::test]
async fn archived_channel_keeps_reads_positions_grants_and_subscription(pool: PgPool) {
    let f = fixture(&pool).await;
    owner(&pool, &f).await;
    let private = channel(&pool, f.organization, f.member, true).await;
    let (reader, token) = member(&pool, f.organization).await;
    grant(&pool, &f, private, reader).await;
    let base = format!("/api/v1/channels/{private}");
    let main = post(&f, private).await;
    let topic_message = request(&f.app, "POST", &format!("{base}/messages"), &f.token,
        json!({"client_message_id":Uuid::new_v4(),"body":format!("@{{member:{reader}}}"),"topic_name":"Topic"})).await;
    assert_eq!(topic_message.status(), StatusCode::CREATED);
    let topic_message = body(topic_message).await;
    let topic_id = topic_message["topic_id"].as_str().unwrap();
    let message_id = topic_message["id"].as_str().unwrap();
    let reply = request(
        &f.app,
        "POST",
        &format!("{base}/messages"),
        &f.token,
        json!({"client_message_id":Uuid::new_v4(),"body":"reply","reply_to":message_id}),
    )
    .await;
    assert_eq!(reply.status(), StatusCode::CREATED);
    let paths = [
        format!("{base}/messages?as_of_seq=3"),
        format!("{base}/events?after_seq=0"),
        format!("{base}/timeline?as_of_seq=3"),
        format!("{base}/topics/{topic_id}/messages?as_of_seq=3"),
        format!("{base}/topics/{topic_id}"),
        format!("{base}/messages/{message_id}/chain"),
        format!("{base}/members"),
    ];
    let mut before = Vec::new();
    for path in &paths {
        before.push(read(&f, &token, path).await);
    }
    let baseline = read(&f, &token, "/api/v1/channels").await;
    let baseline = baseline["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == json!(private))
        .unwrap()
        .clone();
    assert_eq!(baseline["unread_count"], 3);
    assert_eq!(baseline["mention_unread_count"], 1);
    f.state
        .message_delivery
        .channel_access
        .activity
        .drained()
        .await;
    let mut socket = connect(&f, &token).await;
    subscribe(&mut socket, private, 3).await;
    assert_eq!(event(&mut socket).await["type"], "subscribed");
    assert_eq!(
        edit(&f, private, &f.token, json!({"archived":true})).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        notices(&f, &mut socket).await,
        vec![json!({"type":"channel_list_changed"})]
    );
    for (path, input) in [
        (
            format!("{base}/messages"),
            json!({"client_message_id":Uuid::new_v4(),"body":"blocked"}),
        ),
        (
            format!("{base}/messages/{message_id}/move"),
            json!({"operation_id":Uuid::new_v4(),"expected_version":3,"topic_name":"Blocked"}),
        ),
    ] {
        let refusal = request(&f.app, "POST", &path, &f.token, input).await;
        assert_eq!(refusal.status(), StatusCode::CONFLICT);
        assert_eq!(body(refusal).await, json!({"error":"channel_archived"}));
    }
    assert!(notices(&f, &mut socket).await.is_empty());

    let archived = read(&f, &token, "/api/v1/channels?archived=true").await;
    let mut archived = archived["channels"][0].clone();
    assert_eq!(archived["archived"], true);
    archived["archived"] = json!(false);
    assert_eq!(archived, baseline);
    for (path, expected) in paths.iter().zip(before) {
        assert_eq!(read(&f, &token, path).await, expected, "{path}");
    }
    let authors = request(
        &f.app,
        "POST",
        &format!("/api/v1/orgs/{}/message-authors", f.organization),
        &token,
        json!({"ids":[f.member]}),
    )
    .await;
    assert_eq!(authors.status(), StatusCode::OK);
    assert_eq!(body(authors).await["identities"][0]["id"], json!(f.member));

    let mut replay = connect(&f, &token).await;
    subscribe(&mut replay, private, 0).await;
    for seq in 1..=3 {
        let replayed = event(&mut replay).await;
        assert_eq!(replayed["type"], "message");
        assert_eq!(replayed["seq"], seq);
    }
    assert_eq!(event(&mut replay).await["type"], "subscribed");
    for (path, seq) in [
        (
            format!("{base}/read"),
            main["created_seq"].as_i64().unwrap(),
        ),
        (format!("{base}/topics/{topic_id}/read"), 2),
    ] {
        let response = request(&f.app, "PUT", &path, &token, json!({"read_seq":seq})).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body(response).await["read_seq"], seq);
    }
    let _ = notices(&f, &mut socket).await;
    let (added, added_token) = member(&pool, f.organization).await;
    for (method, path, token, input) in [
        (
            "POST",
            format!("{base}/members"),
            &f.token,
            json!({"member_id":added}),
        ),
        (
            "PATCH",
            format!("{base}/members/{added}"),
            &f.token,
            json!({"manager":true}),
        ),
        (
            "DELETE",
            format!("{base}/members/{added}"),
            &added_token,
            Value::Null,
        ),
    ] {
        assert_eq!(
            request(&f.app, method, &path, token, input).await.status(),
            StatusCode::NO_CONTENT
        );
    }
    let _ = notices(&f, &mut socket).await;
    assert_eq!(
        edit(&f, private, &f.token, json!({"archived":false})).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        notices(&f, &mut socket).await,
        vec![json!({"type":"channel_list_changed"})]
    );
    let restored = read(&f, &token, "/api/v1/channels").await;
    let restored = restored["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == json!(private))
        .unwrap();
    assert_eq!(restored["read_seq"], 1);
    assert_eq!(restored["unread_count"], 1);
    assert_eq!(restored["mention_unread_count"], 0);
    assert_eq!(restored["as_of_seq"], 3);
    assert_eq!(
        restored["history_generation"],
        baseline["history_generation"]
    );
    post(&f, private).await;
    assert_eq!(event(&mut socket).await["seq"], 4);
}
