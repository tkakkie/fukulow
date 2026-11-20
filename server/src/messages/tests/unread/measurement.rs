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

// Reconstruct LIST_COUNTS_SQL at main 4fa2ba0 by reversing only #356's
// materialized lower-bound column and removal of the second position join.
fn before_rls_seq_bound() -> String {
    crate::messages::unread::LIST_COUNTS_SQL
        .replace(
            "t.id, t.last_seq,\n        COALESCE(tr.read_seq, p.initial_seq) AS read_seq",
            "t.id, t.last_seq",
        )
        .replace(
            "FROM unread_topics t\n",
            "FROM unread_topics t\n    LEFT JOIN topic_read_positions tr ON tr.organization_id = $1 AND tr.channel_id = c.channel_id\n        AND tr.member_id = $2 AND tr.topic_id = t.id\n",
        )
        .replace("m.seq > t.read_seq", "m.seq > COALESCE(tr.read_seq, p.initial_seq)")
        .replace("t.last_seq > t.read_seq", "t.last_seq > COALESCE(tr.read_seq, p.initial_seq)")
}

// Pool executors release connections asynchronously, including protocol drain,
// rollback and ping. Prove both quiescence and visibility before inspecting plans.
async fn vacuum_messages_visible(connection: &mut sqlx::PgConnection) -> Result<(), String> {
    const ATTEMPTS: usize = 20;
    let mut diagnostic = String::new();
    for attempt in 1..=ATTEMPTS {
        let (transactions, backends): (i64, String) = sqlx::query_as(
            "SELECT count(*), COALESCE(json_agg(json_build_object(
                 'pid', pid,
                 'backend_type', backend_type,
                 'application_name', application_name,
                 'state', state,
                 'wait_event_type', wait_event_type,
                 'wait_event', wait_event,
                 'backend_xid_set', backend_xid IS NOT NULL,
                 'backend_xmin_set', backend_xmin IS NOT NULL,
                 'transaction_age_ms', (EXTRACT(EPOCH FROM clock_timestamp() - xact_start) * 1000)::bigint,
                 'query', left(query, 120)
             ) ORDER BY pid)::text, '[]')
             FROM pg_stat_activity WHERE datname=current_database()
             AND pid<>pg_backend_pid() AND (backend_xid IS NOT NULL OR backend_xmin IS NOT NULL)",
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap();
        sqlx::query("VACUUM(ANALYZE) messages")
            .execute(&mut *connection)
            .await
            .unwrap();
        let (visible, total): (i32, i32) = sqlx::query_as(
            "SELECT relallvisible,relpages FROM pg_class WHERE oid='messages'::regclass",
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap();
        if transactions == 0 && visible == total {
            return Ok(());
        }
        diagnostic = format!(
            "messages VACUUM exhausted {attempt} attempts: {visible}/{total} visible/total pages; \
             {transactions} other same-database transactions; backends: {backends}"
        );
        if attempt < ATTEMPTS {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    Err(diagnostic)
}

#[fukulow_test::test]
async fn main_unread_count_uses_covering_range_without_message_heap(pool: PgPool) {
    // No Router or restricted pool is needed during SQL-only fixture setup.
    let org = organization(&pool).await;
    let sender = Uuid::new_v4();
    member(&pool, org, sender).await;
    let channel = Uuid::new_v4();
    super::super::channel(&pool, org, channel, sender, false).await;
    let viewer = Uuid::new_v4();
    member(&pool, org, viewer).await;
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query("INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT $1,gen_random_uuid(),$2,n,CASE WHEN n%2=0 THEN $3 ELSE $4 END,gen_random_uuid(),repeat('x',1024) FROM generate_series(1,10000) n")
        .bind(org).bind(channel).bind(sender).bind(viewer).execute(&mut *connection).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_message_sequences(organization_id,channel_id,seq) VALUES($1,$2,10000)",
    )
    .bind(org)
    .bind(channel)
    .execute(&mut *connection)
    .await
    .unwrap();
    sqlx::query("INSERT INTO message_mentions SELECT organization_id,channel_id,id,$3 FROM messages WHERE organization_id=$1 AND channel_id=$2 AND seq%10=0")
        .bind(org).bind(channel).bind(viewer).execute(&mut *connection).await.unwrap();
    vacuum_messages_visible(&mut connection).await.unwrap();
    drop(connection);
    let app = crate::test_app_pool(pool.clone()).await;
    let mut tx = app.begin().await.unwrap();
    crate::database::set_organization(&mut tx, org)
        .await
        .unwrap();
    sqlx::query("SET LOCAL plan_cache_mode=force_generic_plan")
        .execute(&mut *tx)
        .await
        .unwrap();
    let row = sqlx::query(crate::messages::unread::LIST_COUNTS_SQL)
        .bind(org)
        .bind(viewer)
        .bind(0_i64)
        .bind([channel])
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(row.get::<i64, _>("unread_count"), 5_000);
    assert_eq!(row.get::<i64, _>("mention_unread_count"), 1_000);
    let plan: Value = sqlx::query_scalar(&format!(
        "EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) {}",
        crate::messages::unread::LIST_COUNTS_SQL
    ))
    .bind(org)
    .bind(viewer)
    .bind(0_i64)
    .bind([channel])
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    fn covering(node: &Value) -> Option<&Value> {
        if node["Index Name"] == "messages_main_unread_covering" {
            return Some(node);
        }
        node["Plans"].as_array()?.iter().find_map(covering)
    }
    let scan = covering(&plan[0]["Plan"]).expect("covering main-scope index range");
    assert_eq!(scan["Node Type"], "Index Only Scan");
    assert_eq!(scan["Heap Fetches"], 0);
    assert_eq!(scan["Actual Rows"].as_f64().unwrap(), 5_000.0);
    assert_eq!(scan["Rows Removed by Filter"].as_f64().unwrap(), 5_000.0);
    tx.rollback().await.unwrap();
    app.close().await;
}

#[fukulow_test::test]
async fn covering_range_vacuum_reports_held_same_database_transaction(pool: PgPool) {
    let org = organization(&pool).await;
    let sender = Uuid::new_v4();
    member(&pool, org, sender).await;
    let channel = Uuid::new_v4();
    super::super::channel(&pool, org, channel, sender, false).await;
    let mut held = pool.begin().await.unwrap();
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *held)
        .await
        .unwrap();
    sqlx::query("SELECT txid_current(), count(*) FROM messages")
        .fetch_one(&mut *held)
        .await
        .unwrap();
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query("INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT $1,gen_random_uuid(),$2,n,$3,gen_random_uuid(),repeat('x',1024) FROM generate_series(1,100) n")
        .bind(org).bind(channel).bind(sender).execute(&mut *connection).await.unwrap();
    let diagnostic = vacuum_messages_visible(&mut connection).await.unwrap_err();
    assert!(diagnostic.contains("exhausted 20 attempts"), "{diagnostic}");
    assert!(diagnostic.contains("visible/total pages"), "{diagnostic}");
    assert!(
        diagnostic.contains("1 other same-database transactions"),
        "{diagnostic}"
    );
    let (visible, total): (i32, i32) = sqlx::query_as(
        "SELECT relallvisible,relpages FROM pg_class WHERE oid='messages'::regclass",
    )
    .fetch_one(&mut *connection)
    .await
    .unwrap();
    assert!(
        visible < total,
        "held snapshot must prevent full visibility"
    );
    held.rollback().await.unwrap();
    vacuum_messages_visible(&mut connection).await.unwrap();
}

// Messages rows a plan reads (returned, filtered or rejected by a lossy bitmap
// recheck, over every loop), and any sequential Messages scan. A full scan from
// initial_seq reads every Topic.
fn message_work(node: &Value, work: &mut f64) -> Result<(), String> {
    if node["Relation Name"] == "messages" {
        if node["Node Type"] == "Seq Scan" {
            return Err(format!("sequential Messages scan: {node}"));
        }
        *work += (node["Actual Rows"].as_f64().unwrap_or(0.0)
            + node["Rows Removed by Filter"].as_f64().unwrap_or(0.0)
            + node["Rows Removed by Index Recheck"]
                .as_f64()
                .unwrap_or(0.0))
            * node["Actual Loops"].as_f64().unwrap_or(1.0);
    }
    for child in node["Plans"].as_array().into_iter().flatten() {
        message_work(child, work)?;
    }
    Ok(())
}

fn bounded_message_work(plan: &Value, bound: f64) -> Result<f64, String> {
    let mut work = 0.0;
    message_work(&plan[0]["Plan"], &mut work)?;
    if work > bound {
        return Err(format!("Unread count read {work} Messages, bound {bound}"));
    }
    Ok(work)
}

// A lossy Bitmap Heap Scan returning 25 rows and filtering 25 can still reject
// more history in its recheck: that work counts toward the bound (#498 review).
#[test]
fn message_work_counts_lossy_bitmap_recheck() {
    let plan = serde_json::json!([{ "Plan": { "Node Type": "Aggregate", "Plans": [{
        "Node Type": "Bitmap Heap Scan", "Relation Name": "messages", "Actual Rows": 25.0,
        "Rows Removed by Filter": 25.0, "Rows Removed by Index Recheck": 900.0, "Actual Loops": 1.0,
        "Plans": [{ "Node Type": "Bitmap Index Scan", "Index Name": "messages_pkey", "Actual Rows": 950.0 }]
    }] } }]);
    let error = bounded_message_work(&plan, 50.0).unwrap_err();
    assert!(error.contains("read 950 Messages"), "{error}");
}

// Always-on guard for #220's ranges (#225): fully read Topics never touch Messages,
// and the one unread Topic is read only above its persisted position, including
// under RLS (#356).
#[fukulow_test::test]
async fn unread_topic_counts_read_only_unread_topic_ranges(pool: PgPool) {
    const TOPICS: i64 = 20;
    const PER_TOPIC: i64 = 50;
    let org = organization(&pool).await;
    let sender = Uuid::new_v4();
    member(&pool, org, sender).await;
    let channel = Uuid::new_v4();
    super::super::channel(&pool, org, channel, sender, false).await;
    let viewer = Uuid::new_v4();
    member(&pool, org, viewer).await;
    // Topic k holds seq k, k+20, ...; Topics are interleaved across the whole history.
    sqlx::query(
        "INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) \
        SELECT $1,$2,gen_random_uuid(),'Topic '||k,k,k+$3*($4-1),$4 FROM generate_series(1,$3) k",
    )
    .bind(org)
    .bind(channel)
    .bind(TOPICS)
    .bind(PER_TOPIC)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) \
        SELECT $1,gen_random_uuid(),$2,t.first_seq+$3*n,$4,gen_random_uuid(),'plan',t.id \
        FROM topics t CROSS JOIN generate_series(0,$5-1) n WHERE t.organization_id=$1 AND t.channel_id=$2")
        .bind(org).bind(channel).bind(TOPICS).bind(sender).bind(PER_TOPIC).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_message_sequences(organization_id,channel_id,seq) VALUES($1,$2,$3)",
    )
    .bind(org)
    .bind(channel)
    .bind(TOPICS * PER_TOPIC)
    .execute(&pool)
    .await
    .unwrap();
    // Every Topic but 'Topic 1' is fully read; 'Topic 1' is read up to half its Messages.
    sqlx::query("INSERT INTO topic_read_positions (organization_id,channel_id,member_id,topic_id,read_seq) \
        SELECT $1,$2,$3,id,CASE WHEN name='Topic 1' THEN first_seq+$4*($5/2-1) ELSE last_seq END \
        FROM topics WHERE organization_id=$1 AND channel_id=$2 \
        ON CONFLICT (organization_id,channel_id,member_id,topic_id) DO UPDATE SET read_seq=EXCLUDED.read_seq")
        .bind(org).bind(channel).bind(viewer).bind(TOPICS).bind(PER_TOPIC).execute(&pool).await.unwrap();
    for table in [
        "messages",
        "topics",
        "topic_read_positions",
        "channel_read_positions",
    ] {
        sqlx::query(&format!("ANALYZE {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let app = crate::test_app_pool(pool.clone()).await;
    let explain = |sql: &str| format!("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) {sql}");
    for mode in ["force_custom_plan", "force_generic_plan", "auto"] {
        let mut tx = app.begin().await.unwrap();
        crate::database::set_organization(&mut tx, org)
            .await
            .unwrap();
        sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
            .execute(&mut *tx)
            .await
            .unwrap();
        // EXPLAIN with bound parameters replans its inner query. PREPARE/EXECUTE
        // exercises the selected cache mode. Auto may choose either plan;
        // both are covered by the forced modes.
        sqlx::raw_sql(&format!(
            "PREPARE unread_topic_range(uuid,uuid,bigint,uuid[]) AS {}",
            crate::messages::unread::LIST_COUNTS_SQL
        ))
        .execute(&mut *tx)
        .await
        .unwrap();
        let arguments = format!("('{org}','{viewer}',0,ARRAY['{channel}']::uuid[])");
        let execute = format!("EXECUTE unread_topic_range{arguments}");
        for _ in 0..if mode == "auto" { 6 } else { 1 } {
            let row = sqlx::query(&execute).fetch_one(&mut *tx).await.unwrap();
            assert_eq!(row.get::<i64, _>("unread_count"), PER_TOPIC / 2, "{mode}");
        }
        let plan: Value = sqlx::query_scalar(&explain(&execute))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DEALLOCATE unread_topic_range")
            .execute(&mut *tx)
            .await
            .unwrap();
        // Neither the 950 fully read Topic Messages nor this Topic's read prefix
        // may be scanned: only its 25 unread Messages fit the bound.
        bounded_message_work(&plan, (PER_TOPIC / 2) as f64)
            .unwrap_or_else(|error| panic!("{mode}: {error}\n{plan}"));
        // #356's regression reads the whole 50-Message Topic, including its
        // read prefix, and must fail the same 25-Message bound in every mode.
        sqlx::raw_sql(&format!(
            "PREPARE unread_topic_before_rls(uuid,uuid,bigint,uuid[]) AS {}",
            before_rls_seq_bound()
        ))
        .execute(&mut *tx)
        .await
        .unwrap();
        let execute_before_rls = format!("EXECUTE unread_topic_before_rls{arguments}");
        for _ in 0..if mode == "auto" { 6 } else { 1 } {
            let row = sqlx::query(&execute_before_rls)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
            assert_eq!(row.get::<i64, _>("unread_count"), PER_TOPIC / 2, "{mode}");
        }
        let before_rls: Value = sqlx::query_scalar(&explain(&execute_before_rls))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DEALLOCATE unread_topic_before_rls")
            .execute(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            bounded_message_work(&before_rls, PER_TOPIC as f64).unwrap(),
            PER_TOPIC as f64,
            "{mode}: {before_rls}"
        );
        let error = bounded_message_work(&before_rls, (PER_TOPIC / 2) as f64).unwrap_err();
        assert!(
            error.contains("read 50 Messages, bound 25"),
            "{mode}: {error}"
        );
        if mode == "force_generic_plan" {
            // Negative control: #220's reviewed full-history query must fail the same check.
            sqlx::raw_sql(&format!(
                "PREPARE unread_topic_before(uuid,uuid,bigint,uuid[]) AS {BEFORE}"
            ))
            .execute(&mut *tx)
            .await
            .unwrap();
            let before: Value =
                sqlx::query_scalar(&explain(&format!("EXECUTE unread_topic_before{arguments}")))
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
            sqlx::query("DEALLOCATE unread_topic_before")
                .execute(&mut *tx)
                .await
                .unwrap();
            let error = bounded_message_work(&before, (PER_TOPIC / 2) as f64).unwrap_err();
            assert!(error.contains("Messages"), "{error}");
        }
        tx.rollback().await.unwrap();
    }
    app.close().await;
}

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
