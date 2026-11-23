use super::*;
use crate::messages::topics::projection::{page_sql, reference};
use sqlx::Connection;
use tracing::instrument::WithSubscriber;

async fn prepared(reader: &mut sqlx::PgConnection) {
    // to_jsonb compares every output column, including the latest Message,
    // serialized Mentions and history_generation, in SQL response order.
    sqlx::raw_sql(&format!(
        "SET jit=off;
         PREPARE page_before AS SELECT false AS rewritten, to_jsonb(p) AS payload FROM ({}) p;
         PREPARE page_after AS SELECT true AS rewritten, to_jsonb(p) AS payload FROM ({}) p;",
        reference::page_sql(),
        page_sql()
    ))
    .execute(reader)
    .await
    .unwrap();
}

async fn compare(tx: &mut sqlx::PgConnection, args: &str, context: &str) {
    // Send both EXECUTEs in one round trip while keeping their plans independent.
    let rows = sqlx::raw_sql(&format!(
        "EXECUTE page_before{args}; EXECUTE page_after{args};"
    ))
    .fetch_all(tx)
    .await
    .unwrap();
    let mut before = Vec::new();
    let mut after = Vec::new();
    for row in rows {
        let mut payload: Value = row.get("payload");
        if row.get("rewritten") {
            let drift = payload.as_object_mut().unwrap().remove("count_drift");
            assert_eq!(drift, Some(Value::Bool(false)), "{context} {args}");
            after.push(payload);
        } else {
            before.push(payload);
        }
    }
    assert_eq!(before, after, "{context} {args}");
}

struct Window {
    channel: Uuid,
    watermarks: Vec<(i64, Option<i64>)>,
    topics: Vec<Uuid>,
}

impl Window {
    async fn read(tx: &mut sqlx::PgConnection, org: Uuid, channel: Uuid) -> Self {
        let (latest, floor) = sqlx::query_as(
            "SELECT seq, mutation_seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2",
        )
        .bind(org).bind(channel).fetch_optional(&mut *tx).await.unwrap().unwrap_or((0, 0));
        let mut samples = vec![
            latest,
            (latest - 1).max(floor),
            floor + (latest - floor) / 2,
            floor,
        ];
        samples.dedup();
        let mut watermarks = Vec::new();
        for w in samples {
            let position = sqlx::query_scalar(
                "SELECT max(seq) FROM messages
                 WHERE organization_id=$1 AND channel_id=$2 AND topic_id IS NOT NULL
                     AND NOT deleted AND seq <= $3
                 GROUP BY topic_id ORDER BY max(seq) DESC OFFSET 1 LIMIT 1",
            )
            .bind(org)
            .bind(channel)
            .bind(w)
            .fetch_optional(&mut *tx)
            .await
            .unwrap();
            watermarks.push((w, position));
        }
        let topics = sqlx::query_scalar(
            "SELECT id FROM topics WHERE organization_id=$1 AND channel_id=$2 ORDER BY name_key",
        )
        .bind(org)
        .bind(channel)
        .fetch_all(tx)
        .await
        .unwrap();
        Self {
            channel,
            watermarks,
            topics,
        }
    }
}

fn literal(value: Option<impl ToString>) -> String {
    value.map_or_else(|| "NULL".into(), |v| format!("'{}'", v.to_string()))
}

async fn assert_pages(world: &World, reader: &mut sqlx::PgConnection, step: usize, action: &str) {
    let org = world.org;
    let mut tx = reader.begin().await.unwrap();
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await
        .unwrap();
    crate::database::set_organization(&mut tx, org)
        .await
        .unwrap();
    let mut viewers = Vec::new();
    for (member, _) in &world.members {
        let revision: i64 = sqlx::query_scalar(
            "SELECT membership_revision FROM users WHERE organization_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(member)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        viewers.push((*member, revision));
    }
    viewers.push((Uuid::nil(), 0));
    let mut windows = Vec::new();
    for channel in world.channels {
        windows.push(Window::read(&mut tx, org, channel).await);
    }
    for mode in ["force_custom_plan", "force_generic_plan"] {
        sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
            .execute(&mut *tx)
            .await
            .unwrap();
        let context = format!("{action}, {mode}");
        for Window {
            channel,
            watermarks,
            topics,
        } in &windows
        {
            for (j, &(w, position)) in watermarks.iter().enumerate() {
                for (i, (member, revision)) in viewers.iter().enumerate() {
                    // Check the latest W for every viewer and rotate older W across viewers.
                    if j > 0 && j != 1 + (step + i) % (watermarks.len() - 1) {
                        continue;
                    }
                    let k = step + i + j;
                    let edge = [None, Some(1), Some(w.max(1)), Some(w + 1)][k % 4];
                    let limit = [1, 2, 200][k % 3] + 1;
                    let args = |before, topics_only, topic: Option<&Uuid>| {
                        let before = literal(before);
                        let filter = literal(topic);
                        format!(
                            "('{org}','{member}',{revision},'{channel}',{w},{before},{limit},{topics_only},{filter})"
                        )
                    };
                    for topics_only in [false, true] {
                        let before = if topics_only == step.is_multiple_of(2) {
                            position.or(edge)
                        } else {
                            edge
                        };
                        compare(&mut tx, &args(before, topics_only, None), &context).await;
                    }
                    if let Some(topic) = topics.get(k % topics.len().max(1)) {
                        compare(&mut tx, &args(edge, true, Some(topic)), &context).await;
                    }
                }
            }
        }
    }
    tx.rollback().await.unwrap();
}

// One test per seed so nextest can run the seeds in parallel and spread them across CI shards (#800).
// The unsuffixed test is seed 0, the name docs/invariants cites.
#[fukulow_test::test]
async fn topic_pages_equal_the_prefix_query_after_every_random_step(pool: PgPool) {
    assert_seed(&pool, SEEDS[0]).await;
}

#[fukulow_test::test]
async fn topic_pages_equal_the_prefix_query_after_every_random_step_seed_1(pool: PgPool) {
    assert_seed(&pool, SEEDS[1]).await;
}

#[fukulow_test::test]
async fn topic_pages_equal_the_prefix_query_after_every_random_step_seed_2(pool: PgPool) {
    assert_seed(&pool, SEEDS[2]).await;
}

async fn assert_seed(pool: &PgPool, seed: u64) {
    let world = World::new(pool).await;
    let mut reader = world.reader.acquire().await.unwrap();
    prepared(&mut reader).await;
    let [public, _] = world.channels;
    let (owner, owner_token) = &world.members[0];
    let (viewer, viewer_token) = &world.members[1];
    let no_position = world.members[2].0;
    let guest = world.members[3].0;
    let mut rng = Rng(seed);
    let mut keys = Vec::new();

    assert_pages(&world, &mut reader, 0, "empty Channels").await;
    role(pool, world.org, guest, "guest").await;
    sqlx::query("DELETE FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(world.org).bind(public).bind(no_position).execute(pool).await.unwrap();
    let initial = [
        (owner_token, None, *viewer),
        (owner_token, Some("T1"), *viewer),
        (viewer_token, Some("T2"), *owner),
        (owner_token, Some("T1"), *viewer),
        (viewer_token, Some("T1"), *viewer),
        (owner_token, Some("T3"), no_position),
        // At W=7, the boundary from T3 leaves both positioned T1 and unchanged T2.
        (owner_token, Some("T4"), *viewer),
        (owner_token, Some("T1"), *viewer),
    ];
    for (i, (token, topic, target)) in initial.into_iter().enumerate() {
        let value = json!({
            "client_message_id":Uuid::new_v4(), "topic_name":topic, "body":format!("@{{member:{target}}}")
        });
        let message = sent(&world.app, token, public, value.clone()).await;
        assert_topic_summaries(pool, world.org, public, "seeded append").await;
        let who = usize::from(token == viewer_token);
        keys.push((
            who,
            public,
            Uuid::parse_str(message["id"].as_str().unwrap()).unwrap(),
            value,
        ));
        assert_pages(&world, &mut reader, i + 1, "seeded append").await;
    }
    for n in 0..STEPS {
        let action = step(&world, pool, &mut rng, &mut keys).await;
        let context = format!("seed {seed:x} step {n}: {action}");
        assert_pages(&world, &mut reader, n + initial.len() + 1, &context).await;
    }
    let plans: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT custom_plans,generic_plans FROM pg_prepared_statements WHERE name IN ('page_before','page_after')",
    )
    .fetch_all(&mut *reader).await.unwrap();
    assert_eq!(plans.len(), 2);
    assert!(
        plans
            .iter()
            .all(|&(custom, generic)| custom > 0 && generic > 0)
    );
    drop(reader);
    world.reader.close().await;
}

#[fukulow_test::test]
async fn topic_page_clamps_negative_unread_and_logs_drift(pool: PgPool) {
    let (app, org, _, channel, owner) = fixture(&pool).await;
    let viewer = member(&pool, org, Uuid::new_v4()).await;
    let message = post(&app, &owner, channel, Some("Drift")).await;
    let topic = Uuid::parse_str(message["topic_id"].as_str().unwrap()).unwrap();
    post(&app, &owner, channel, Some("Drift")).await;

    let suffix = "topics?as_of_seq=1";
    let before = get_projection(&app, &viewer, channel, suffix).await;
    assert_eq!(before["topics"][0]["unread_count"], 1);
    // Zeroing the total leaves a raw count of -1 after the post-W append is subtracted.
    let updated = sqlx::query(
        "UPDATE message_append_counts SET appended=0
         WHERE organization_id=$1 AND channel_id=$2 AND scope_id=$3 AND member_id=$4",
    )
    .bind(org)
    .bind(channel)
    .bind(topic)
    .bind(Uuid::nil())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(updated.rows_affected(), 1);

    let capture = crate::observability::tests::Capture::default();
    let page = get_projection(&app, &viewer, channel, suffix)
        .with_subscriber(capture.subscriber())
        .await;
    assert_eq!(page["topics"][0]["unread_count"], 0);
    let drift: Vec<_> = capture
        .events()
        .into_iter()
        .filter(|event| event["fields"]["event"] == "unread_count_drift")
        .collect();
    assert_eq!(drift.len(), 1, "{drift:?}");
    assert_eq!(drift[0]["level"], "ERROR");
}
