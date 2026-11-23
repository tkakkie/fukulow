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

// The list counts SQL before #519 A3 (65f63307), kept as the exact oracle and as
// the negative control for the A3 plan and buffer guards.
pub(super) const PRE_A3: &str = include_str!("counts_pre_a3.sql");

#[derive(Debug, Default)]
struct VacuumDiagnostic {
    message: String,
    client_pids: Vec<i64>,
}

fn client_transaction_pids(backends: &[Value]) -> Vec<i64> {
    backends
        .iter()
        .filter(|backend| {
            backend["backend_type"] == "client backend"
                && (backend["backend_xid_set"] == true || backend["backend_xmin_set"] == true)
        })
        .map(|backend| backend["pid"].as_i64().unwrap())
        .collect()
}

// Pool executors release connections asynchronously. Autovacuum and autoanalyze
// can briefly delay visibility. Wait for both client quiescence and full visibility.
async fn vacuum_messages_visible(
    connection: &mut sqlx::PgConnection,
) -> Result<(), VacuumDiagnostic> {
    const ATTEMPTS: usize = 20;
    let mut diagnostic = VacuumDiagnostic::default();
    for attempt in 1..=ATTEMPTS {
        let backends: Value = sqlx::query_scalar(
            "SELECT COALESCE(json_agg(json_build_object(
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
             ) ORDER BY pid), '[]')
             FROM pg_stat_activity WHERE datname=current_database()
             AND pid<>pg_backend_pid() AND (backend_xid IS NOT NULL OR backend_xmin IS NOT NULL)",
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap();
        let client_pids = client_transaction_pids(backends.as_array().unwrap());
        let transactions = client_pids.len();
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
        diagnostic = VacuumDiagnostic {
            message: format!(
                "messages VACUUM exhausted {attempt} attempts: {visible}/{total} visible/total pages; \
                 {transactions} other same-database client transactions; backends: {backends}"
            ),
            client_pids,
        };
        if attempt < ATTEMPTS {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    Err(diagnostic)
}

#[test]
fn vacuum_counts_client_transactions_but_not_autovacuum() {
    let mut backends = vec![
        serde_json::json!({
            "pid": 2455,
            "backend_type": "autovacuum worker",
            "state": "active",
            "wait_event_type": "Timeout",
            "wait_event": "VacuumDelay",
            "backend_xid_set": false,
            "backend_xmin_set": true,
            "transaction_age_ms": 9,
            "query": "autovacuum: VACUUM ANALYZE pg_catalog.pg_shdepend"
        }),
        serde_json::json!({
            "pid": 2414,
            "backend_type": "client backend",
            "backend_xid_set": false,
            "backend_xmin_set": true
        }),
    ];
    assert_eq!(client_transaction_pids(&backends), [2414]);

    backends.push(serde_json::json!({
        "pid": 2456,
        "backend_type": "client backend",
        "backend_xid_set": true,
        "backend_xmin_set": false
    }));
    assert_eq!(client_transaction_pids(&backends), [2414, 2456]);
}

#[fukulow_test::test]
async fn unread_list_count_buffers_do_not_grow_with_unread(pool: PgPool) {
    let org = organization(&pool).await;
    let sender = Uuid::new_v4();
    member(&pool, org, sender).await;
    let channel = Uuid::new_v4();
    super::super::channel(&pool, org, channel, sender, false).await;
    let viewer = Uuid::new_v4();
    member(&pool, org, viewer).await;
    let topic = Uuid::new_v4();
    // Odd seqs are main, even seqs one Topic; every 7th is the viewer's own. No VACUUM:
    // the unread tail is not all-visible, as under continuous sends.
    sqlx::query("ALTER TABLE messages SET (autovacuum_enabled=false)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO topics(organization_id,channel_id,id,name,first_seq,last_seq,message_count) VALUES($1,$2,$3,'Plan',2,40000,20000)")
        .bind(org).bind(channel).bind(topic).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) SELECT $1,gen_random_uuid(),$2,n,CASE WHEN n%7=0 THEN $3 ELSE $4 END,gen_random_uuid(),repeat('x',200),CASE WHEN n%2=0 THEN $5 END FROM generate_series(1,40000) n")
        .bind(org).bind(channel).bind(viewer).bind(sender).bind(topic).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences VALUES($1,$2,40000)")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO topic_read_positions(organization_id,channel_id,member_id,topic_id,read_seq) VALUES($1,$2,$3,$4,0)")
        .bind(org).bind(channel).bind(viewer).bind(topic).execute(&pool).await.unwrap();
    for table in [
        "topics",
        "channel_read_positions",
        "topic_read_positions",
        "message_append_counts",
        "message_count_corrections",
    ] {
        sqlx::query(&format!("ANALYZE {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let app = crate::test_app_pool(pool.clone()).await;
    for mode in ["force_custom_plan", "force_generic_plan", "auto"] {
        let mut buffers = std::collections::HashMap::new();
        // 1x: 200 unread seqs per scope; 100x: 20,000.
        for (cut, read) in [(1, 39_600_i64), (100, 0)] {
            sqlx::query("UPDATE channel_read_positions SET read_seq=$3 WHERE organization_id=$1 AND member_id=$2")
                .bind(org).bind(viewer).bind(read).execute(&pool).await.unwrap();
            sqlx::query("UPDATE topic_read_positions SET read_seq=$3 WHERE organization_id=$1 AND member_id=$2")
                .bind(org).bind(viewer).bind(read).execute(&pool).await.unwrap();
            let mut tx = app.begin().await.unwrap();
            crate::database::set_organization(&mut tx, org)
                .await
                .unwrap();
            sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
                .execute(&mut *tx)
                .await
                .unwrap();
            let mut rows = Vec::new();
            for (arm, sql) in [
                ("pre_a3", PRE_A3),
                ("a3", crate::messages::unread::LIST_COUNTS_SQL),
            ] {
                sqlx::raw_sql(&format!(
                    "PREPARE counts519(uuid,uuid,bigint,uuid[]) AS {sql}"
                ))
                .execute(&mut *tx)
                .await
                .unwrap();
                let execute =
                    format!("EXECUTE counts519('{org}','{viewer}',0,ARRAY['{channel}']::uuid[])");
                // Auto may switch to a generic plan after five executions.
                for _ in 0..if mode == "auto" { 6 } else { 1 } {
                    sqlx::query(&execute).fetch_one(&mut *tx).await.unwrap();
                }
                let row = sqlx::query(&execute).fetch_one(&mut *tx).await.unwrap();
                rows.push((
                    row.get::<i64, _>("main_unread_count"),
                    row.get::<i64, _>("unread_count"),
                ));
                let plan: Value =
                    sqlx::query_scalar(&format!("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) {execute}"))
                        .fetch_one(&mut *tx)
                        .await
                        .unwrap();
                sqlx::query("DEALLOCATE counts519")
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                let root = &plan[0]["Plan"];
                let blocks = root["Shared Hit Blocks"].as_i64().unwrap_or(0)
                    + root["Shared Read Blocks"].as_i64().unwrap_or(0);
                eprintln!("UNREAD_BUFFERS {mode} {arm} cut={cut} blocks={blocks}");
                buffers.insert((arm, cut), blocks);
                assert_eq!(
                    reads_relation(root, "messages"),
                    arm == "pre_a3",
                    "{mode} {arm}: {plan}"
                );
            }
            assert_eq!(rows[0], rows[1], "{mode} cut={cut}");
            tx.rollback().await.unwrap();
        }
        // A3 reads counts, positions and empty correction and Mention ranges: a fixed
        // number of pages whatever the backlog. The pre-A3 SQL must fail the same bound.
        const SLACK: i64 = 32;
        assert!(
            buffers[&("a3", 100)] <= buffers[&("a3", 1)] + SLACK,
            "{mode}: {buffers:?}"
        );
        assert!(
            buffers[&("pre_a3", 100)] > buffers[&("pre_a3", 1)] + SLACK,
            "{mode}: {buffers:?}"
        );
    }
    app.close().await;
}

fn reads_relation(node: &Value, relation: &str) -> bool {
    node["Relation Name"] == relation
        || node["Plans"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|child| reads_relation(child, relation))
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
    let held_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *held)
        .await
        .unwrap();
    let mut connection = pool.acquire().await.unwrap();
    sqlx::query("INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT $1,gen_random_uuid(),$2,n,$3,gen_random_uuid(),repeat('x',1024) FROM generate_series(1,100) n")
        .bind(org).bind(channel).bind(sender).execute(&mut *connection).await.unwrap();
    let VacuumDiagnostic {
        message,
        client_pids,
    } = vacuum_messages_visible(&mut connection).await.unwrap_err();
    assert!(message.contains("exhausted 20 attempts"), "{message}");
    assert!(message.contains("visible/total pages"), "{message}");
    assert_eq!(client_pids, [i64::from(held_pid)], "{message}");
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

// #519 A3: the counts never read Messages in any plan mode, under RLS, and equal
// the pre-A3 SQL for fully read, partly read and missing Topic positions, own and
// moved Messages and Mentions. The pre-A3 SQL is the negative control.
#[fukulow_test::test]
async fn unread_list_counts_never_read_messages_in_any_plan_mode(pool: PgPool) {
    const TOPICS: i64 = 20;
    const PER_TOPIC: i64 = 50;
    let org = organization(&pool).await;
    let sender = Uuid::new_v4();
    member(&pool, org, sender).await;
    let channel = Uuid::new_v4();
    super::super::channel(&pool, org, channel, sender, false).await;
    let viewer = Uuid::new_v4();
    member(&pool, org, viewer).await;
    // Topic k holds seq k, k+20, ...; main Messages follow at 1001..1400.
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
        SELECT $1,gen_random_uuid(),$2,t.first_seq+$3*n,CASE WHEN n%9=0 THEN $5 ELSE $4 END,gen_random_uuid(),'plan',t.id \
        FROM topics t CROSS JOIN generate_series(0,$6-1) n WHERE t.organization_id=$1 AND t.channel_id=$2")
        .bind(org).bind(channel).bind(TOPICS).bind(sender).bind(viewer).bind(PER_TOPIC).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) \
        SELECT $1,gen_random_uuid(),$2,n,CASE WHEN n%9=0 THEN $4 ELSE $3 END,gen_random_uuid(),'plan' FROM generate_series(1001,1400) n")
        .bind(org).bind(channel).bind(sender).bind(viewer).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO channel_message_sequences(organization_id,channel_id,seq) VALUES($1,$2,1400)",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    // Move main seqs 1301..1340 into 'Topic 2' and Topic seqs of 'Topic 3' to main.
    sqlx::query("UPDATE messages SET topic_id=(SELECT id FROM topics WHERE organization_id=$1 AND name='Topic 2') WHERE organization_id=$1 AND seq BETWEEN 1301 AND 1340")
        .bind(org).execute(&pool).await.unwrap();
    sqlx::query("UPDATE messages SET topic_id=NULL WHERE organization_id=$1 AND topic_id=(SELECT id FROM topics WHERE organization_id=$1 AND name='Topic 3') AND seq > 500")
        .bind(org).execute(&pool).await.unwrap();
    sqlx::query("UPDATE topics t SET last_seq=(SELECT max(seq) FROM messages m WHERE m.organization_id=t.organization_id AND m.topic_id=t.id) WHERE organization_id=$1")
        .bind(org).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO message_mentions SELECT organization_id,channel_id,id,$2 FROM messages WHERE organization_id=$1 AND seq%10=0")
        .bind(org).bind(viewer).execute(&pool).await.unwrap();
    // Main read to 1200. 'Topic 1' is read to half; 'Topic 4' has no row (initial_seq);
    // the rest are fully read.
    sqlx::query(
        "UPDATE channel_read_positions SET read_seq=1200 WHERE organization_id=$1 AND member_id=$2",
    )
    .bind(org)
    .bind(viewer)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO topic_read_positions (organization_id,channel_id,member_id,topic_id,read_seq) \
        SELECT $1,$2,$3,id,CASE WHEN name='Topic 1' THEN first_seq+$4*($5/2-1) ELSE last_seq END \
        FROM topics WHERE organization_id=$1 AND channel_id=$2 AND name<>'Topic 4' \
        ON CONFLICT (organization_id,channel_id,member_id,topic_id) DO UPDATE SET read_seq=EXCLUDED.read_seq")
        .bind(org).bind(channel).bind(viewer).bind(TOPICS).bind(PER_TOPIC).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM topic_read_positions WHERE organization_id=$1 AND member_id=$2 AND topic_id=(SELECT id FROM topics WHERE organization_id=$1 AND name='Topic 4')")
        .bind(org).bind(viewer).execute(&pool).await.unwrap();
    let check: i64 = sqlx::query_scalar("SELECT count(*) FROM message_counts_check($1)")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    // 'Topic 4' was created after the viewer's position, so its missing row is ordinals
    // 0 at initial_seq, which the check confirms exact.
    assert_eq!(check, 0);
    for table in [
        "messages",
        "topics",
        "topic_read_positions",
        "channel_read_positions",
        "message_mentions",
        "message_append_counts",
        "message_count_corrections",
    ] {
        sqlx::query(&format!("ANALYZE {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let app = crate::test_app_pool(pool.clone()).await;
    for mode in ["force_custom_plan", "force_generic_plan", "auto"] {
        let mut tx = app.begin().await.unwrap();
        crate::database::set_organization(&mut tx, org)
            .await
            .unwrap();
        let rls: bool = sqlx::query_scalar("SELECT row_security_active('message_append_counts')")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert!(rls);
        sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
            .execute(&mut *tx)
            .await
            .unwrap();
        let mut results = Vec::new();
        for (arm, sql) in [
            ("pre_a3", PRE_A3),
            ("a3", crate::messages::unread::LIST_COUNTS_SQL),
        ] {
            sqlx::raw_sql(&format!(
                "PREPARE counts519(uuid,uuid,bigint,uuid[]) AS {sql}"
            ))
            .execute(&mut *tx)
            .await
            .unwrap();
            let execute =
                format!("EXECUTE counts519('{org}','{viewer}',0,ARRAY['{channel}']::uuid[])");
            let mut row = None;
            for _ in 0..if mode == "auto" { 6 } else { 1 } {
                row = Some(sqlx::query(&execute).fetch_one(&mut *tx).await.unwrap());
            }
            let row = row.unwrap();
            results.push(
                [
                    "as_of_seq",
                    "read_seq",
                    "main_unread_count",
                    "unread_count",
                    "main_mention_unread_count",
                    "mention_unread_count",
                ]
                .map(|c| row.get::<i64, _>(c)),
            );
            let plan: Value =
                sqlx::query_scalar(&format!("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) {execute}"))
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
            sqlx::query("DEALLOCATE counts519")
                .execute(&mut *tx)
                .await
                .unwrap();
            assert_eq!(
                reads_relation(&plan[0]["Plan"], "messages"),
                arm == "pre_a3",
                "{mode} {arm}: {plan}"
            );
        }
        assert_eq!(results[0], results[1], "{mode}");
        assert!(
            results[1][3] > results[1][2] && results[1][5] > 0,
            "{mode}: fixture must have Topic Unread and Mentions: {results:?}"
        );
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
        "message_append_counts",
        "message_count_corrections",
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
