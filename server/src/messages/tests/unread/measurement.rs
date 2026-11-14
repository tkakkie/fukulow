use super::*;
use sqlx::Row;
use std::time::Instant;

// Keep the reviewed query as a reproducible comparator, never an application path.
const BEFORE: &str = r#"
SELECT p.channel_id, p.read_seq,
 count(m.seq) FILTER (WHERE m.topic_id IS NULL AND m.seq > p.read_seq) AS main_unread_count,
 count(m.seq) FILTER (WHERE m.seq > CASE WHEN m.topic_id IS NULL THEN p.read_seq
     ELSE COALESCE(t.read_seq, p.initial_seq) END) AS unread_count
 FROM channel_read_positions p
 LEFT JOIN messages m ON m.organization_id = p.organization_id AND m.channel_id = p.channel_id AND m.sender <> p.member_id AND m.seq > p.initial_seq
 LEFT JOIN topic_read_positions t ON t.organization_id = p.organization_id AND t.channel_id = p.channel_id
     AND t.member_id = p.member_id AND t.topic_id = m.topic_id
 WHERE p.organization_id = $1 AND p.member_id = $2 AND p.membership_revision = $3 AND p.channel_id = ANY($4)
 GROUP BY p.channel_id, p.read_seq
"#;

#[fukulow_test::test]
#[ignore = "manual before/after release query measurement; run without other builds/tests"]
async fn measure_unread_list_read_position_ranges(pool: PgPool) {
    let history: i64 = std::env::var("MEASURE_HISTORY")
        .map(|s| s.parse().unwrap())
        .unwrap_or(50_000);
    assert!(history >= 100 && history % 20 == 0);
    let (_, org, sender, first, _) = fixture(&pool).await;
    let viewer = Uuid::new_v4();
    member(&pool, org, viewer).await;
    let mut ids = vec![first];
    for _ in 1..20 {
        let id = Uuid::new_v4();
        super::super::channel(&pool, org, id, sender, false).await;
        ids.push(id);
    }
    sqlx::query(
        "INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) \
        SELECT $1,c,gen_random_uuid(),'Topic '||n,2*n-1,$3-20+2*n-1,$3/20 \
        FROM unnest($2::uuid[]) c CROSS JOIN generate_series(1,10) n",
    )
    .bind(org)
    .bind(&ids)
    .bind(history)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) \
        SELECT $1,gen_random_uuid(),c,2*n,$3,gen_random_uuid(),'measurement' \
        FROM unnest($2::uuid[]) c CROSS JOIN generate_series(1,$4/2) n",
    )
    .bind(org)
    .bind(&ids)
    .bind(sender)
    .bind(history)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) \
        SELECT $1,gen_random_uuid(),channel_id,n,$2,gen_random_uuid(),'measurement',id \
        FROM topics CROSS JOIN LATERAL generate_series(first_seq,last_seq,20) n WHERE organization_id=$1")
        .bind(org).bind(sender).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences SELECT $1,c,$3 FROM unnest($2::uuid[]) c")
        .bind(org)
        .bind(&ids)
        .bind(history)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO topic_read_positions \
        SELECT $1,channel_id,$2,id,$3 FROM topics WHERE organization_id=$1",
    )
    .bind(org)
    .bind(viewer)
    .bind(history)
    .execute(&pool)
    .await
    .unwrap();
    for table in [
        "messages",
        "topics",
        "channel_read_positions",
        "topic_read_positions",
        "channel_message_sequences",
    ] {
        sqlx::query(&format!("ANALYZE {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    for tail in [0_i64, 100] {
        sqlx::query("UPDATE channel_read_positions SET read_seq=$3 WHERE organization_id=$1 AND member_id=$2")
            .bind(org).bind(viewer).bind(history-tail).execute(&pool).await.unwrap();
        sqlx::query(
            "UPDATE topic_read_positions SET read_seq=$3 WHERE organization_id=$1 AND member_id=$2",
        )
        .bind(org)
        .bind(viewer)
        .bind(history - tail)
        .execute(&pool)
        .await
        .unwrap();
        for (name, query) in [
            ("before", BEFORE),
            ("after", crate::messages::unread::LIST_COUNTS_SQL),
        ] {
            let mut samples = Vec::new();
            for run in 0..55 {
                let start = Instant::now();
                let rows = sqlx::query(query)
                    .bind(org)
                    .bind(viewer)
                    .bind(0_i64)
                    .bind(&ids)
                    .fetch_all(&pool)
                    .await
                    .unwrap();
                let ms = start.elapsed().as_secs_f64() * 1000.0;
                assert_eq!(rows.len(), 20);
                for row in rows {
                    assert_eq!(row.get::<i64, _>("read_seq"), history - tail);
                    assert_eq!(row.get::<i64, _>("main_unread_count"), tail / 2);
                    assert_eq!(row.get::<i64, _>("unread_count"), tail);
                }
                if run >= 5 {
                    samples.push(ms);
                }
            }
            samples.sort_by(f64::total_cmp);
            eprintln!(
                "UNREAD {name} channels=20 topics=200 history_per_channel={history} total_messages={} tail_per_channel={tail} samples=50 p50_ms={:.3} p95_ms={:.3} max_ms={:.3}",
                history * 20,
                samples[24],
                samples[47],
                samples[49]
            );
            let plan: Value =
                sqlx::query_scalar(&format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {query}"))
                    .bind(org)
                    .bind(viewer)
                    .bind(0_i64)
                    .bind(&ids)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            eprintln!(
                "UNREAD_PLAN {name} history={history} tail={tail} {}",
                serde_json::to_string(&plan).unwrap()
            );
        }
    }
}
