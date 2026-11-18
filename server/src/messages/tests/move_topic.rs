use super::*;
use crate::messages::move_topic::MoveChainResponse;
use std::time::Duration;

mod denials;
mod races;

struct Fixture {
    app: Router,
    state: AppState,
    org: Uuid,
    channel: Uuid,
    sender: Uuid,
    token: String,
}

impl Fixture {
    async fn new(pool: &PgPool) -> Self {
        let org = organization(pool).await;
        let sender = Uuid::new_v4();
        let token = member(pool, org, sender).await;
        let id = Uuid::new_v4();
        channel(pool, org, id, sender, false).await;
        let state = AppState::for_test(pool.clone()).await;
        let app = crate::app(state.clone());
        Self {
            app,
            state,
            org,
            channel: id,
            sender,
            token,
        }
    }

    async fn post(&self, token: &str, value: Value) -> Value {
        sent(&self.app, token, self.channel, value).await
    }

    async fn root(&self) -> Value {
        self.post(&self.token, input(Uuid::new_v4(), "root")).await
    }
}

fn id(message: &Value) -> Uuid {
    serde_json::from_value(message["id"].clone()).unwrap()
}

fn named(version: i64, name: &str) -> Value {
    json!({"operation_id": Uuid::new_v4(), "expected_version": version, "topic_name": name})
}

fn reply(key: Uuid, anchor: &Value) -> Value {
    json!({"client_message_id": key, "body": "Reply", "reply_to": anchor["id"]})
}

async fn move_request(
    app: &Router,
    token: &str,
    channel: Uuid,
    anchor: Uuid,
    input: Value,
) -> Response {
    request(
        app,
        "POST",
        &format!("/api/v1/channels/{channel}/messages/{anchor}/move"),
        token,
        input,
    )
    .await
}

async fn moved(response: Response) -> MoveChainResponse {
    let status = response.status();
    let payload = body(response).await;
    assert_eq!(status, StatusCode::OK, "{payload}");
    serde_json::from_value(payload).unwrap()
}

async fn error(response: Response, status: StatusCode, code: &str) {
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let actual = response.status();
    let payload = body(response).await;
    assert_eq!((actual, payload), (status, json!({"error":code})));
}

async fn state(pool: &PgPool, org: Uuid, channel: Uuid) -> Value {
    sqlx::query_scalar(
        r#"SELECT jsonb_build_array(
        (SELECT to_jsonb(s) FROM channel_message_sequences s WHERE organization_id=$1 AND channel_id=$2),
        (SELECT jsonb_agg(m ORDER BY seq) FROM messages m WHERE organization_id=$1 AND channel_id=$2),
        (SELECT jsonb_agg(t ORDER BY id) FROM topics t WHERE organization_id=$1 AND channel_id=$2),
        (SELECT jsonb_agg(l ORDER BY event_seq) FROM channel_log l WHERE organization_id=$1 AND channel_id=$2),
        (SELECT jsonb_agg(r ORDER BY actor, operation_id) FROM operation_receipts r WHERE organization_id=$1 AND channel_id=$2),
        (SELECT jsonb_agg(p ORDER BY member_id) FROM channel_read_positions p WHERE organization_id=$1 AND channel_id=$2),
        (SELECT jsonb_agg(p ORDER BY member_id,topic_id) FROM topic_read_positions p WHERE organization_id=$1 AND channel_id=$2))"#,
    ).bind(org).bind(channel).fetch_one(pool).await.unwrap()
}

async fn mark_tombstone(pool: &PgPool, f: &Fixture, message: &Value) {
    // Stage 1 has no Delete endpoint. Supply a tombstone as committed storage state.
    let mut tx = pool.begin().await.unwrap();
    let result = sqlx::query(
        "UPDATE messages SET deleted=true WHERE organization_id=$1 AND channel_id=$2 AND id=$3",
    )
    .bind(f.org)
    .bind(f.channel)
    .bind(id(message))
    .execute(&mut *tx)
    .await
    .unwrap();
    assert_eq!(result.rows_affected(), 1);
    if let Some(topic) = message["topic_id"].as_str() {
        sqlx::query(
            "UPDATE topics SET message_count=(SELECT count(*) FROM messages WHERE organization_id=$1 AND channel_id=$2 AND topic_id=$3 AND NOT deleted), \
             first_seq=(SELECT min(seq) FROM messages WHERE organization_id=$1 AND channel_id=$2 AND topic_id=$3 AND NOT deleted), \
             last_seq=(SELECT max(seq) FROM messages WHERE organization_id=$1 AND channel_id=$2 AND topic_id=$3 AND NOT deleted) \
             WHERE organization_id=$1 AND channel_id=$2 AND id=$3",
        )
        .bind(f.org).bind(f.channel).bind(topic.parse::<Uuid>().unwrap())
        .execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
}

#[fukulow_test::test]
async fn move_from_descendant_rewrites_whole_chain_including_tombstones_and_keeps_send_identity(
    pool: PgPool,
) {
    let f = Fixture::new(&pool).await;
    let root_input =
        json!({"client_message_id":Uuid::new_v4(), "body":"original", "topic_name":"Source"});
    let root = f.post(&f.token, root_input.clone()).await;
    let child = f.post(&f.token, reply(Uuid::new_v4(), &root)).await;
    let leaf = f.post(&f.token, reply(Uuid::new_v4(), &child)).await;
    mark_tombstone(&pool, &f, &child).await;
    let chain_path = format!(
        "/api/v1/channels/{}/messages/{}/chain",
        f.channel,
        id(&root)
    );
    let first = body(
        request(
            &f.app,
            "GET",
            &format!("{chain_path}?limit=1"),
            &f.token,
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(first["messages"].as_array().unwrap().len(), 1);
    assert_eq!(first["messages"][0]["version"], 1);
    assert_eq!(first["chain_version"], 3);

    let outcome = moved(
        move_request(
            &f.app,
            &f.token,
            f.channel,
            id(&leaf),
            named(3, "Destination"),
        )
        .await,
    )
    .await;
    assert_eq!(
        (outcome.root_id, outcome.move_seq, outcome.chain_version),
        (id(&root), Some(4), 4)
    );
    let all = body(request(&f.app, "GET", &chain_path, &f.token, Value::Null).await).await;
    assert_eq!(all["chain_version"], 4);
    let messages = all["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    for (new, old) in messages.iter().zip([&root, &child, &leaf]) {
        for field in ["id", "reply_to", "reply_root_id", "created_seq"] {
            assert_eq!(new[field], old[field]);
        }
        assert_eq!(new["topic_id"], json!(outcome.destination_topic_id));
        assert_eq!(new["version"], 4);
    }
    assert_eq!(messages[1]["deleted"], true);
    assert!(messages[1].get("body").is_none());
    assert!(messages[1].get("mentions").is_none());
    assert_eq!(f.post(&f.token, root_input).await, messages[0]);
    let counters: (i64, i64) = sqlx::query_as("SELECT seq, mutation_seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2")
        .bind(f.org).bind(f.channel).fetch_one(&pool).await.unwrap();
    assert_eq!(counters, (4, 4));
    let change: (Uuid, Uuid, Uuid, Uuid, Uuid) = sqlx::query_as(
        "SELECT message_id,sender,operation_id,source_topic_id,destination_topic_id FROM channel_log \
         WHERE organization_id=$1 AND channel_id=$2 AND event_seq=4 AND kind='move'",
    ).bind(f.org).bind(f.channel).fetch_one(&pool).await.unwrap();
    assert_eq!(
        change,
        (
            id(&root),
            f.sender,
            outcome.operation_id,
            root["topic_id"].as_str().unwrap().parse().unwrap(),
            outcome.destination_topic_id
        )
    );
}

#[fukulow_test::test]
async fn move_rejects_mismatched_chain_and_rolls_back_partial_rewrite(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let root = f.root().await;
    let child = f.post(&f.token, reply(Uuid::new_v4(), &root)).await;
    let other = f.root().await;
    for trigger in [false, true] {
        if trigger {
            sqlx::raw_sql(
                "CREATE FUNCTION refuse_move_update() RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN IF OLD.reply_root_id IS NOT NULL THEN RETURN NULL; END IF; RETURN NEW; END $$;
                 CREATE TRIGGER refuse_move_update BEFORE UPDATE OF topic_id ON messages
                    FOR EACH ROW EXECUTE FUNCTION refuse_move_update();",
            ).execute(&pool).await.unwrap();
        } else {
            sqlx::query("UPDATE messages SET reply_root_id=$4 WHERE organization_id=$1 AND channel_id=$2 AND id=$3")
                .bind(f.org).bind(f.channel).bind(id(&child)).bind(id(&other)).execute(&pool).await.unwrap();
        }
        let before = state(&pool, f.org, f.channel).await;
        let mut queue = f.state.message_delivery.queue(f.org, (f.sender, 0), 256);
        queue.subscribe(f.channel);
        let response =
            move_request(&f.app, &f.token, f.channel, id(&root), named(2, "Target")).await;
        assert_error(response, StatusCode::INTERNAL_SERVER_ERROR).await;
        assert_eq!(state(&pool, f.org, f.channel).await, before);
        f.state.message_delivery.flush().await;
        assert!(queue.events.try_recv().is_err());
        if trigger {
            sqlx::query("DROP TRIGGER refuse_move_update ON messages")
                .execute(&pool)
                .await
                .unwrap();
        } else {
            sqlx::query("UPDATE messages SET reply_root_id=$4 WHERE organization_id=$1 AND channel_id=$2 AND id=$3")
                .bind(f.org).bind(f.channel).bind(id(&child)).bind(id(&root)).execute(&pool).await.unwrap();
        }
    }
    assert_eq!(
        moved(move_request(&f.app, &f.token, f.channel, id(&root), named(2, "Target")).await)
            .await
            .move_seq,
        Some(4)
    );
}

#[fukulow_test::test]
async fn move_from_main_to_new_topic_uses_access_baseline_and_creation_positions(pool: PgPool) {
    let f = Fixture::new(&pool).await;
    let root = f.root().await;
    let reader = Uuid::new_v4();
    let token = member(&pool, f.org, reader).await;
    let child = f.post(&f.token, json!({
        "client_message_id":Uuid::new_v4(),"body":format!("@{{member:{reader}}}"),"reply_to":root["id"]
    })).await;
    let mark = request(
        &f.app,
        "PUT",
        &format!("/api/v1/channels/{}/read", f.channel),
        &token,
        json!({"read_seq":2}),
    )
    .await;
    assert_eq!(mark.status(), StatusCode::OK);
    let counts = || request(&f.app, "GET", "/api/v1/channels", &token, Value::Null);
    let before = body(counts().await).await;
    assert_eq!(before["channels"][0]["unread_count"], 0);
    assert_eq!(before["channels"][0]["mention_unread_count"], 0);
    let result =
        moved(move_request(&f.app, &f.token, f.channel, id(&child), named(2, "Fresh")).await).await;
    let main = body(
        request(
            &f.app,
            "GET",
            &format!("/api/v1/channels/{}/timeline", f.channel),
            &token,
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(main["as_of_seq"], 3);
    let items = main["items"].as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["kind"], "topic");
    let topic = &items[0]["topic"];
    assert_eq!(topic["id"], json!(result.destination_topic_id));
    assert_eq!(topic["first_seq"], 1);
    assert_eq!(topic["last_seq"], 2);
    assert_eq!(topic["read_seq"], 1);
    assert_eq!(topic["message_count"], 2);
    assert_eq!(topic["unread_count"], 1);
    assert_eq!(topic["mention_unread_count"], 1);
    let after = body(counts().await).await;
    assert_eq!(after["channels"][0]["read_seq"], 2);
    assert_eq!(after["channels"][0]["main_unread_count"], 0);
    assert_eq!(after["channels"][0]["unread_count"], 1);
    assert_eq!(after["channels"][0]["mention_unread_count"], 1);
}
