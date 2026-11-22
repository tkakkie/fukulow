use super::*;
use crate::messages::topics::projection::{page_sql, reference};
use sqlx::Connection;

async fn prepared(reader: &mut sqlx::PgConnection) {
    // to_jsonb compares every output column, including the latest Message,
    // serialized Mentions and history_generation, in SQL response order.
    sqlx::raw_sql(&format!(
        "SET jit=off;
         PREPARE page_before AS SELECT to_jsonb(p) FROM ({}) p;
         PREPARE page_after AS SELECT to_jsonb(p) FROM ({}) p;",
        reference::page_sql(),
        page_sql()
    ))
    .execute(reader)
    .await
    .unwrap();
}

async fn compare(tx: &mut sqlx::PgConnection, args: &str, context: &str) {
    let before: Vec<Value> = sqlx::query_scalar(&format!("EXECUTE page_before{args}"))
        .persistent(false)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    let mut after: Vec<Value> = sqlx::query_scalar(&format!("EXECUTE page_after{args}"))
        .persistent(false)
        .fetch_all(&mut *tx)
        .await
        .unwrap();
    for row in &mut after {
        let drift = row.as_object_mut().unwrap().remove("count_drift");
        assert_eq!(drift, Some(Value::Bool(false)), "{context} {args}");
    }
    assert_eq!(before, after, "{context} {args}");
}

struct Window {
    channel: Uuid,
    latest: i64,
    floor: i64,
    topics: Vec<Uuid>,
}

impl Window {
    async fn read(tx: &mut sqlx::PgConnection, org: Uuid, channel: Uuid) -> Self {
        let (latest, floor) = sqlx::query_as(
            "SELECT seq, mutation_seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2",
        )
        .bind(org).bind(channel).fetch_optional(&mut *tx).await.unwrap().unwrap_or((0, 0));
        let topics = sqlx::query_scalar(
            "SELECT id FROM topics WHERE organization_id=$1 AND channel_id=$2 ORDER BY first_seq, id",
        )
        .bind(org).bind(channel).fetch_all(tx).await.unwrap();
        Self {
            channel,
            latest,
            floor,
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
        let context = format!("step {step} ({action}), {mode}");
        for Window {
            channel,
            latest,
            floor,
            topics,
        } in &windows
        {
            for (i, (member, revision)) in viewers.iter().enumerate() {
                for (j, w) in [*latest, (latest - 1).max(*floor), *floor]
                    .into_iter()
                    .enumerate()
                {
                    // Rotate boundaries, filters and sizes across steps and viewers.
                    let k = step + i + j;
                    let before = literal([None, Some(1), Some(w.max(1)), Some(w + 1)][k % 4]);
                    let limit = [1, 2, 200][k % 3] + 1;
                    let filter = literal(topics.get(k % topics.len().max(1)));
                    for topics_only in [false, true] {
                        for filter in ["NULL", filter.as_str()] {
                            let args = format!(
                                "('{org}','{member}',{revision},'{channel}',{w},{before},{limit},{topics_only},{filter})"
                            );
                            compare(&mut tx, &args, &context).await;
                        }
                    }
                }
            }
        }
    }
    tx.rollback().await.unwrap();
}

#[fukulow_test::test]
async fn topic_pages_equal_the_prefix_query_after_every_random_step(pool: PgPool) {
    let world = World::new(&pool).await;
    let mut reader = world.reader.acquire().await.unwrap();
    prepared(&mut reader).await;
    let [public, _] = world.channels;
    let (owner, owner_token) = &world.members[0];
    let (viewer, viewer_token) = &world.members[1];
    let no_position = world.members[2].0;
    let guest = world.members[3].0;
    let mut rng = Rng(0x0007_58a3);
    let mut keys = Vec::new();

    assert_pages(&world, &mut reader, 0, "empty Channels").await;
    role(&pool, world.org, guest, "guest").await;
    sqlx::query("DELETE FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3")
        .bind(world.org).bind(public).bind(no_position).execute(&pool).await.unwrap();
    let seed = [
        (owner_token, None, *viewer),
        (owner_token, Some("T1"), *viewer),
        (viewer_token, Some("T2"), *owner),
        (owner_token, Some("T1"), *viewer),
        (viewer_token, Some("T1"), *viewer),
        (owner_token, Some("T3"), no_position),
    ];
    for (i, (token, topic, target)) in seed.into_iter().enumerate() {
        let value = json!({
            "client_message_id":Uuid::new_v4(), "topic_name":topic, "body":format!("@{{member:{target}}}")
        });
        let message = sent(&world.app, token, public, value.clone()).await;
        let who = usize::from(token == viewer_token);
        keys.push((
            who,
            public,
            Uuid::parse_str(message["id"].as_str().unwrap()).unwrap(),
            value,
        ));
        assert_pages(&world, &mut reader, i + 1, "seeded append").await;
    }
    for n in 0..100 {
        let action = step(&world, &pool, &mut rng, &mut keys).await;
        assert_pages(&world, &mut reader, n + 7, &action).await;
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
}
