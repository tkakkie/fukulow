use super::*;
use crate::messages::unread::LIST_COUNTS_SQL;
use sqlx::Row;

// Main before #519, including #356's materialized Topic lower bound.
const BEFORE: &str = include_str!("counts_before.sql");
// PR #569 round 1 (555f055), retained as the many-Topic negative control.
const ROUND1: &str = include_str!("counts_round1.sql");

#[derive(Debug, Default)]
struct MentionWork {
    loops: f64,
    buffers: i64,
}

fn mention_work(node: &Value, work: &mut MentionWork) {
    // Count relation scans, not enclosing joins/aggregates whose buffers would
    // count the same work again.
    if node["Relation Name"] == "message_mentions" {
        work.loops += node["Actual Loops"].as_f64().unwrap();
        work.buffers += node["Shared Hit Blocks"].as_i64().unwrap_or(0)
            + node["Shared Read Blocks"].as_i64().unwrap_or(0);
    }
    for child in node["Plans"].as_array().into_iter().flatten() {
        mention_work(child, work);
    }
}

fn bounded_mentions(work: &MentionWork, rows: i64) -> Result<(), String> {
    // Two scopes may each visit the Member's set, never probe per unread Message.
    let bound = 2 * (rows + 2);
    if work.loops > bound as f64 {
        return Err(format!(
            "message_mentions loops {}, bound {bound} (Mention rows {rows})",
            work.loops
        ));
    }
    Ok(())
}

fn counts(row: &sqlx::postgres::PgRow) -> (i64, i64, bool, i64, i64, i64, i64) {
    (
        row.get("as_of_seq"),
        row.get("read_seq"),
        row.get("missing_position"),
        row.get("main_unread_count"),
        row.get("unread_count"),
        row.get("main_mention_unread_count"),
        row.get("mention_unread_count"),
    )
}

#[fukulow_test::test]
async fn unread_mentions_probe_work_is_bounded_by_mentions_not_unread(pool: PgPool) {
    let org = organization(&pool).await;
    let sender = Uuid::new_v4();
    member(&pool, org, sender).await;
    let channel = Uuid::new_v4();
    super::super::channel(&pool, org, channel, sender, false).await;
    let viewer = Uuid::new_v4();
    member(&pool, org, viewer).await;
    let topic = Uuid::new_v4();
    sqlx::query("INSERT INTO topics(organization_id,channel_id,id,name,first_seq,last_seq,message_count) VALUES($1,$2,$3,'Plan',2,10020,5010)")
        .bind(org).bind(channel).bind(topic).execute(&pool).await.unwrap();
    // Even seqs belong to a Topic; own Messages and rows above the committed
    // counter exercise exclusions independently of Mention density.
    sqlx::query("INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) SELECT $1,gen_random_uuid(),$2,n,CASE WHEN n%7=0 THEN $3 ELSE $4 END,gen_random_uuid(),'plan',CASE WHEN n%2=0 THEN $5 END FROM generate_series(1,10020) n")
        .bind(org).bind(channel).bind(viewer).bind(sender).bind(topic).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences VALUES($1,$2,10000)")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO topic_read_positions(organization_id,channel_id,member_id,topic_id,read_seq) VALUES($1,$2,$3,$4,0)")
        .bind(org).bind(channel).bind(viewer).bind(topic).execute(&pool).await.unwrap();
    let app = crate::test_app_pool(pool.clone()).await;
    let flags: (bool, bool) =
        sqlx::query_as("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
            .fetch_one(&app)
            .await
            .unwrap();
    assert_eq!(flags, (false, false));

    for density in ["zero", "few", "many"] {
        sqlx::query("DELETE FROM message_mentions WHERE organization_id=$1")
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
        // Other Members' Mentions must not affect either count. Keep enough
        // rows that the real member/channel index is relevant even at zero.
        sqlx::query("INSERT INTO message_mentions SELECT organization_id,channel_id,id,$2 FROM messages WHERE organization_id=$1")
            .bind(org).bind(sender).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO message_mentions SELECT organization_id,channel_id,id,$2 FROM messages WHERE organization_id=$1 AND CASE $3 WHEN 'few' THEN seq%997=0 WHEN 'many' THEN seq%5<>0 ELSE false END")
            .bind(org).bind(viewer).bind(density).execute(&pool).await.unwrap();
        let mention_rows: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM message_mentions WHERE organization_id=$1 AND member_id=$2",
        )
        .bind(org)
        .bind(viewer)
        .fetch_one(&pool)
        .await
        .unwrap();
        for table in [
            "messages",
            "message_mentions",
            "topics",
            "channel_read_positions",
            "topic_read_positions",
            "channel_message_sequences",
        ] {
            sqlx::query(&format!("VACUUM (ANALYZE) {table}"))
                .execute(&pool)
                .await
                .unwrap();
        }
        for mode in ["force_custom_plan", "force_generic_plan"] {
            let mut small = None::<MentionWork>;
            for (label, main_read, topic_read) in [("small", 9801_i64, 9704_i64), ("large", 23, 44)]
            {
                sqlx::query("UPDATE channel_read_positions SET read_seq=$3 WHERE organization_id=$1 AND member_id=$2")
                    .bind(org).bind(viewer).bind(main_read).execute(&pool).await.unwrap();
                sqlx::query("UPDATE topic_read_positions SET read_seq=$3 WHERE organization_id=$1 AND member_id=$2")
                    .bind(org).bind(viewer).bind(topic_read).execute(&pool).await.unwrap();
                let mut tx = app.begin().await.unwrap();
                sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                crate::database::set_organization(&mut tx, org)
                    .await
                    .unwrap();
                let active: (bool, bool) = sqlx::query_as("SELECT row_security_active('messages'),row_security_active('message_mentions')")
                    .fetch_one(&mut *tx).await.unwrap();
                assert_eq!(active, (true, true));
                sqlx::query("SET LOCAL jit=off")
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                let mut expected = [0_i64; 4];
                for seq in 1..=10000 {
                    let main = seq % 2 != 0;
                    if seq > if main { main_read } else { topic_read } && seq % 7 != 0 {
                        expected[if main { 0 } else { 1 }] += 1;
                        if (density == "many" && seq % 5 != 0)
                            || (density == "few" && seq % 997 == 0)
                        {
                            expected[if main { 2 } else { 3 }] += 1;
                        }
                    }
                }
                let expected = (
                    10000,
                    main_read,
                    false,
                    expected[0],
                    expected[0] + expected[1],
                    expected[2],
                    expected[2] + expected[3],
                );
                let mut old_buffers = 0;
                for (arm, statement) in [
                    ("old", BEFORE),
                    ("round1", ROUND1),
                    ("new", LIST_COUNTS_SQL),
                ] {
                    sqlx::raw_sql(&format!(
                        "PREPARE mention_counts519(uuid,uuid,bigint,uuid[]) AS {statement}"
                    ))
                    .execute(&mut *tx)
                    .await
                    .unwrap();
                    let execute = format!(
                        "EXECUTE mention_counts519('{org}','{viewer}',0,ARRAY['{channel}']::uuid[])"
                    );
                    let row = sqlx::query(&execute).fetch_one(&mut *tx).await.unwrap();
                    assert_eq!(counts(&row), expected, "{density} {mode} {label} {arm}");
                    let plan: Value = sqlx::query_scalar(&format!(
                        "EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) {execute}"
                    ))
                    .fetch_one(&mut *tx)
                    .await
                    .unwrap();
                    let mut work = MentionWork::default();
                    mention_work(&plan[0]["Plan"], &mut work);
                    let root_buffers = plan[0]["Plan"]["Shared Hit Blocks"].as_i64().unwrap_or(0)
                        + plan[0]["Plan"]["Shared Read Blocks"].as_i64().unwrap_or(0);
                    eprintln!(
                        "MENTION_WORK {density} {mode} {label} {arm} rows={mention_rows} unread={} loops={} mention_buffers={} root_buffers={root_buffers}",
                        expected.4, work.loops, work.buffers
                    );
                    if arm == "old" {
                        old_buffers = root_buffers;
                    }
                    if arm == "new" {
                        assert!(
                            root_buffers <= old_buffers + 128,
                            "{density} {mode} {label}: main={old_buffers} new={root_buffers}"
                        );
                        bounded_mentions(&work, mention_rows)
                            .unwrap_or_else(|e| panic!("{density} {mode} {label}: {e}"));
                        if let Some(small) = &small {
                            assert!(
                                work.loops <= small.loops + 2.0,
                                "{density} {mode}: {small:?} -> {work:?}"
                            );
                            assert!(
                                work.buffers <= small.buffers + 8,
                                "{density} {mode}: {small:?} -> {work:?}"
                            );
                        } else {
                            small = Some(work);
                        }
                    } else if arm == "old"
                        && density != "many"
                        && label == "large"
                        && mode == "force_generic_plan"
                    {
                        // Run the identical guard against the old actual statement,
                        // retaining its failure as a deterministic negative control.
                        let error = bounded_mentions(&work, mention_rows).unwrap_err();
                        eprintln!("OLD_GUARD_FAILURE {density} {mode}: {error}");
                    }
                    let cached: (i64,i64)=sqlx::query_as("SELECT custom_plans,generic_plans FROM pg_prepared_statements WHERE name='mention_counts519'")
                        .fetch_one(&mut *tx).await.unwrap();
                    assert_eq!(
                        cached,
                        if mode == "force_custom_plan" {
                            (2, 0)
                        } else {
                            (0, 2)
                        }
                    );
                    sqlx::query("DEALLOCATE mention_counts519")
                        .execute(&mut *tx)
                        .await
                        .unwrap();
                }
                tx.rollback().await.unwrap();
            }
        }
    }
    app.close().await;
}

// The same 8,000 Mentions are historical in (b) and unread in (c).
// A hundred unread Topics catch repeated scans even when scan loops alone
// look small compared with the number of stored Mentions.
#[fukulow_test::test]
async fn unread_topic_mentions_scan_channel_set_once(pool: PgPool) {
    let org = organization(&pool).await;
    let sender = Uuid::new_v4();
    member(&pool, org, sender).await;
    let channel = Uuid::new_v4();
    super::super::channel(&pool, org, channel, sender, false).await;
    let viewer = Uuid::new_v4();
    member(&pool, org, viewer).await;
    sqlx::query("INSERT INTO topics(organization_id,channel_id,id,name,first_seq,last_seq,message_count) SELECT $1,$2,gen_random_uuid(),'Plan '||n,(n-1)*100+1,n*100,100 FROM generate_series(1,100) n")
        .bind(org).bind(channel).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) SELECT $1,gen_random_uuid(),$2,t.first_seq+n,$3,gen_random_uuid(),'plan',t.id FROM topics t CROSS JOIN generate_series(0,99) n WHERE t.organization_id=$1")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences VALUES($1,$2,10000)")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO topic_read_positions(organization_id,channel_id,member_id,topic_id,read_seq) SELECT $1,$2,$3,id,last_seq-1 FROM topics WHERE organization_id=$1")
        .bind(org).bind(channel).bind(viewer).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO message_mentions SELECT organization_id,channel_id,id,$2 FROM messages WHERE organization_id=$1 AND (seq-1)%100<80")
        .bind(org).bind(viewer).execute(&pool).await.unwrap();
    let app = crate::test_app_pool(pool.clone()).await;
    let flags: (bool, bool) =
        sqlx::query_as("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
            .fetch_one(&app)
            .await
            .unwrap();
    assert_eq!(flags, (false, false));
    for table in [
        "messages",
        "message_mentions",
        "topics",
        "channel_read_positions",
        "topic_read_positions",
        "channel_message_sequences",
    ] {
        sqlx::query(&format!("VACUUM (ANALYZE) {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    for (shape, unread, mentions) in [("b", 100_i64, 0_i64), ("c", 10000, 8000)] {
        if shape == "c" {
            sqlx::query("UPDATE topic_read_positions SET read_seq=0 WHERE organization_id=$1")
                .bind(org)
                .execute(&pool)
                .await
                .unwrap();
        }
        for mode in ["force_custom_plan", "force_generic_plan"] {
            let mut tx = app.begin().await.unwrap();
            sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                .execute(&mut *tx)
                .await
                .unwrap();
            crate::database::set_organization(&mut tx, org)
                .await
                .unwrap();
            let active: (bool, bool) = sqlx::query_as(
                "SELECT row_security_active('messages'),row_security_active('message_mentions')",
            )
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            assert_eq!(active, (true, true));
            sqlx::query("SET LOCAL jit=off")
                .execute(&mut *tx)
                .await
                .unwrap();
            sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
                .execute(&mut *tx)
                .await
                .unwrap();
            let mut old_buffers = 0;
            for (arm, statement) in [
                ("old", BEFORE),
                ("round1", ROUND1),
                ("new", LIST_COUNTS_SQL),
            ] {
                sqlx::raw_sql(&format!(
                    "PREPARE topic_mentions519(uuid,uuid,bigint,uuid[]) AS {statement}"
                ))
                .execute(&mut *tx)
                .await
                .unwrap();
                let execute = format!(
                    "EXECUTE topic_mentions519('{org}','{viewer}',0,ARRAY['{channel}']::uuid[])"
                );
                let row = sqlx::query(&execute).fetch_one(&mut *tx).await.unwrap();
                assert_eq!(
                    counts(&row),
                    (10000, 0, false, 0, unread, 0, mentions),
                    "{shape} {mode} {arm}"
                );
                let plan: Value =
                    sqlx::query_scalar(&format!("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) {execute}"))
                        .fetch_one(&mut *tx)
                        .await
                        .unwrap();
                let mut work = MentionWork::default();
                mention_work(&plan[0]["Plan"], &mut work);
                let buffers = plan[0]["Plan"]["Shared Hit Blocks"].as_i64().unwrap_or(0)
                    + plan[0]["Plan"]["Shared Read Blocks"].as_i64().unwrap_or(0);
                eprintln!(
                    "MENTION_WORK {shape} {mode} {arm} unread={unread} loops={} mention_buffers={} root_buffers={buffers}",
                    work.loops, work.buffers
                );
                // Each of the two scopes may scan the Member's Channel set once.
                // The buffer allowance covers that set's index pages, not 100
                // repeated scans, and never depends on wall-clock timing.
                let bounded = work.loops <= 2.0 && work.buffers <= 256;
                if arm == "old" {
                    old_buffers = buffers;
                } else if arm == "round1" && shape == "b" {
                    assert!(!bounded, "round-1 negative control must fail: {work:?}");
                    eprintln!(
                        "ROUND1_GUARD_FAILURE {shape} {mode}: {work:?}, bounds loops<=2 buffers<=256"
                    );
                } else if arm == "new" {
                    assert!(bounded, "{shape} {mode}: {work:?}");
                    assert!(
                        buffers <= old_buffers + 128,
                        "{shape} {mode}: main={old_buffers} new={buffers}"
                    );
                }
                let cached: (i64,i64) = sqlx::query_as("SELECT custom_plans,generic_plans FROM pg_prepared_statements WHERE name='topic_mentions519'")
                    .fetch_one(&mut *tx).await.unwrap();
                assert_eq!(
                    cached,
                    if mode == "force_custom_plan" {
                        (2, 0)
                    } else {
                        (0, 2)
                    }
                );
                sqlx::query("DEALLOCATE topic_mentions519")
                    .execute(&mut *tx)
                    .await
                    .unwrap();
            }
            tx.rollback().await.unwrap();
        }
    }
    app.close().await;
}
