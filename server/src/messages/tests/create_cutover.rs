use super::*;
use crate::messages::{log, mentions};

const CUTOVER: i64 = 202611260620;

async fn old_history(pool: &PgPool) -> (Uuid, Uuid) {
    for migration in sqlx::migrate!().iter().filter(|m| m.version < CUTOVER) {
        sqlx::raw_sql(&migration.sql).execute(pool).await.unwrap();
    }
    let org = organization(pool).await;
    let (sender, reader, id, topic) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    member(pool, org, sender).await;
    member(pool, org, reader).await;
    channel(pool, org, id, sender, false).await;
    for sql in [
        "INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count)
         SELECT $1,$2,$4,'Destination',1,1,1 WHERE $3::uuid IS NOT NULL",
        "INSERT INTO messages (organization_id, channel_id, id, seq, sender, client_message_id, body, deleted, topic_id)
         SELECT $1,$2,gen_random_uuid(),n,$3,gen_random_uuid(),CASE WHEN n=1 THEN 'current' ELSE '' END,
             n=3, CASE WHEN n=1 THEN $4 ELSE NULL END FROM unnest(ARRAY[1,3]) n",
        "INSERT INTO channel_log (organization_id,channel_id,event_seq,kind,message_id,sender,operation_id,destination_topic_id)
         SELECT $1,$2,2,'move',id,$3,gen_random_uuid(),$4 FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq=1",
        "UPDATE messages SET version=2 WHERE organization_id=$1 AND channel_id=$2 AND sender=$3 AND topic_id=$4",
        "INSERT INTO channel_message_sequences (organization_id, channel_id, seq, mutation_seq)
         SELECT $1,$2,3,2 WHERE $3::uuid IS NOT NULL AND $4::uuid IS NOT NULL",
    ] {
        sqlx::query(sql).bind(org).bind(id).bind(sender).bind(topic).execute(pool).await.unwrap();
    }
    seed_legacy_creates(pool, org, &[id]).await;
    sqlx::query(
        "INSERT INTO message_mentions (organization_id,channel_id,message_id,member_id)
                 SELECT $1,$2,id,$3 FROM messages WHERE organization_id=$1 AND channel_id=$2",
    )
    .bind(org)
    .bind(id)
    .bind(reader)
    .execute(pool)
    .await
    .unwrap();
    (org, id)
}

// This query captures the old source of positions and its Message-id hydration.
// The production decoder and wire serializer are shared across the comparison.
async fn legacy_wire(pool: &PgPool, org: Uuid, channel: Uuid) -> Vec<u8> {
    let sql = mentions::page_sql(
        r#"SELECT l.event_seq,l.kind,l.message_id,l.source_topic_id,l.destination_topic_id,l.operation_id,
                  false AS duplicate,l.channel_id AS log_channel_id,
                  m.id,m.channel_id,m.seq,m.version,m.deleted,m.client_message_id,m.sender,m.body,m.topic_id,
                  m.reply_to_id AS reply_to,m.reply_root_id,
                  to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
           FROM (SELECT * FROM channel_log WHERE organization_id=$1 AND channel_id=$2
                 AND event_seq>0 AND event_seq<=3 ORDER BY event_seq LIMIT 50) l
           LEFT JOIN messages m ON m.organization_id=l.organization_id AND m.channel_id=l.channel_id
             AND m.id=l.message_id AND l.kind='create'"#,
        "p.event_seq",
    );
    let rows = sqlx::query(&sql)
        .bind(org)
        .bind(channel)
        .fetch_all(pool)
        .await
        .unwrap();
    wire(log::hydrate(rows, 0, 3, 50).unwrap())
}

fn wire(events: Vec<ChannelEvent>) -> Vec<u8> {
    serde_json::to_vec(
        &events
            .into_iter()
            .map(ChannelEvent::into_wire)
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

async fn cutover(pool: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let migrations = sqlx::migrate!();
    let migration = migrations.iter().find(|m| m.version == CUTOVER).unwrap();
    match sqlx::raw_sql(&migration.sql).execute(&mut *tx).await {
        Ok(_) => tx.commit().await,
        Err(error) => {
            tx.rollback().await?;
            Err(error)
        }
    }
}

#[fukulow_test::test(migrations = false)]
async fn create_cutover_preserves_mixed_replay_wire_bytes(pool: PgPool) {
    let (org, channel) = old_history(&pool).await;
    let before = legacy_wire(&pool, org, channel).await;
    cutover(&pool).await.unwrap();
    let restricted = crate::test_app_pool(pool.clone()).await;
    assert_eq!(
        wire(replay_page(&restricted, org, channel, 0, 3).await.unwrap()),
        before
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT event_seq FROM channel_log")
            .fetch_all(&pool)
            .await
            .unwrap(),
        [2]
    );
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT to_regclass('public.channel_log_pkey') IS NOT NULL")
            .fetch_one(&pool)
            .await
            .unwrap()
    );
}

#[fukulow_test::test(migrations = false)]
async fn create_cutover_aborts_on_broken_bijection_gap_or_overlap(pool: PgPool) {
    old_history(&pool).await;
    let relation: i64 = sqlx::query_scalar("SELECT 'public.channel_log'::regclass::oid::bigint")
        .fetch_one(&pool)
        .await
        .unwrap();
    for (break_history, undo, expected) in [
        (
            "UPDATE channel_log SET sender=(SELECT member_id FROM message_mentions LIMIT 1) WHERE event_seq=1",
            "UPDATE channel_log l SET sender=m.sender FROM messages m WHERE l.message_id=m.id AND l.event_seq=1",
            "not in bijection",
        ),
        (
            "UPDATE channel_message_sequences SET seq=4",
            "UPDATE channel_message_sequences SET seq=3",
            "do not cover",
        ),
        (
            "UPDATE channel_log SET event_seq=3 WHERE kind='move';",
            "UPDATE channel_log SET event_seq=2 WHERE kind='move'",
            "overlaps a mutation",
        ),
    ] {
        // Free the old log's slot in the overlap case. The new sources still
        // overlap because the creation Message at that position is retained.
        let mut removed = None;
        if expected == "overlaps a mutation" {
            removed = Some(
                sqlx::query_scalar::<_, Value>(
                    "DELETE FROM channel_log l WHERE event_seq=3 RETURNING to_jsonb(l)",
                )
                .fetch_one(&pool)
                .await
                .unwrap(),
            );
        }
        sqlx::raw_sql(break_history).execute(&pool).await.unwrap();
        let err = cutover(&pool).await.unwrap_err();
        assert!(
            err.as_database_error()
                .unwrap()
                .message()
                .contains(expected),
            "{err}"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT 'public.channel_log'::regclass::oid::bigint")
                .fetch_one(&pool)
                .await
                .unwrap(),
            relation
        );
        assert!(
            sqlx::query_scalar::<_, bool>(
                "SELECT to_regclass('public.channel_log_mutations') IS NULL"
            )
            .fetch_one(&pool)
            .await
            .unwrap()
        );
        sqlx::raw_sql(undo).execute(&pool).await.unwrap();
        if let Some(row) = removed {
            sqlx::query("INSERT INTO channel_log SELECT * FROM jsonb_populate_record(NULL::channel_log, $1)").bind(row).execute(&pool).await.unwrap();
        }
    }
    cutover(&pool).await.unwrap();
}
