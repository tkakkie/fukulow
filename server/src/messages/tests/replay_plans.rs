use super::{channel, member, organization, seed_channel_log};
use crate::messages::{REPLAY_PAGE_SIZE, log};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

#[fukulow_test::test]
async fn replay_hydration_work_is_bounded_by_page_positions(pool: PgPool) {
    let org = organization(&pool).await;
    let sender = Uuid::new_v4();
    member(&pool, org, sender).await;
    // At this size the Message PK and the Channel-scoped index have the same
    // B-tree depth. Exercise replay on both sides of the Channel UUID ordering.
    let channels = [
        (Uuid::from_u128(1), 32_000_i64),
        (Uuid::from_u128(2), 8_000),
    ];
    for (id, size) in channels {
        channel(&pool, org, id, sender, false).await;
        sqlx::query(
            "INSERT INTO messages (organization_id, channel_id, sender, id, seq, client_message_id, body) \
             SELECT $1, $2, $3, md5($2::uuid::text || ':' || n)::uuid, n, gen_random_uuid(), 'plan' \
             FROM generate_series(1, $4::bigint) n",
        )
        .bind(org)
        .bind(id)
        .bind(sender)
        .bind(size)
        .execute(&pool)
        .await
        .unwrap();
    }
    // Every Message carries a Mention, so an Organization-wide Mention scan
    // shows up as rows beyond the page in either plan mode.
    sqlx::query(
        "INSERT INTO message_mentions (organization_id, channel_id, message_id, member_id) \
         SELECT organization_id, channel_id, id, sender FROM messages WHERE organization_id = $1",
    )
    .bind(org)
    .execute(&pool)
    .await
    .unwrap();
    seed_channel_log(&pool).await;
    sqlx::query("ANALYZE messages, channel_log, channels, users, message_mentions")
        .execute(&pool)
        .await
        .unwrap();

    let app = crate::test_app_pool(pool.clone()).await;
    let authorized = crate::database::organization_statement_sql(&log::authorized_page_sql());
    let gap = crate::database::organization_statement_sql(&log::replay_page_sql());
    let mut failures = Vec::new();
    for (id, tip) in channels {
        for (depth, after) in [("deep", tip / 2), ("recent", tip - 60)] {
            for mode in ["force_generic_plan", "force_custom_plan"] {
                for (path, sql, limit) in [
                    ("HTTP", &authorized, REPLAY_PAGE_SIZE + 1),
                    ("subscribe", &authorized, REPLAY_PAGE_SIZE),
                    ("gap", &gap, REPLAY_PAGE_SIZE),
                ] {
                    let scope = if path == "gap" {
                        format!("'{org}','{id}'")
                    } else {
                        format!("'{org}','{sender}',0,'{id}'")
                    };
                    let plan =
                        explain_replay(&app, mode, sql, &format!("{scope},{after},{tip},{limit}"))
                            .await;
                    let case = format!("{tip} Messages {depth} {mode} {path}");
                    check_page_work(&plan[0]["Plan"], &case, limit, &mut failures);
                }
            }
        }
    }
    app.close().await;
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

async fn explain_replay(app: &PgPool, mode: &str, sql: &str, args: &str) -> Value {
    let mut conn = app.acquire().await.unwrap();
    let context: (bool, bool, bool, bool, bool) = sqlx::query_as(
        "SELECT rolsuper, rolbypassrls, row_security_active('messages'), \
                row_security_active('channel_log'), current_setting('fukulow.organization_id', true) IS NULL \
         FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert_eq!(context, (false, false, true, true, true));
    sqlx::raw_sql(&format!("SET jit=off; SET plan_cache_mode={mode}"))
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::raw_sql(&format!("PREPARE replay_page AS {sql} ORDER BY event_seq"))
        .execute(&mut *conn)
        .await
        .unwrap();
    let plan = sqlx::query_scalar(&format!(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE replay_page({args})"
    ))
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    let cached: (i64, i64) = sqlx::query_as(
        "SELECT generic_plans, custom_plans FROM pg_prepared_statements WHERE name='replay_page'",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert_eq!(
        cached,
        if mode == "force_generic_plan" {
            (1, 0)
        } else {
            (0, 1)
        }
    );
    // Closing the backend keeps the GUC completely absent for the next plan.
    conn.close().await.unwrap();
    plan
}

fn relation_nodes<'a>(node: &'a Value, relation: &str, nodes: &mut Vec<&'a Value>) {
    if node["Relation Name"] == relation {
        nodes.push(node);
    }
    for child in node["Plans"].as_array().into_iter().flatten() {
        relation_nodes(child, relation, nodes);
    }
}

fn check_page_work(root: &Value, case: &str, limit: i64, failures: &mut Vec<String>) {
    let mut log = Vec::new();
    let mut messages = Vec::new();
    let mut mentions = Vec::new();
    relation_nodes(root, "channel_log", &mut log);
    relation_nodes(root, "messages", &mut messages);
    relation_nodes(root, "message_mentions", &mut mentions);
    for node in mentions {
        let read = node["Actual Rows"].as_f64().unwrap() * node["Actual Loops"].as_f64().unwrap();
        if node["Node Type"] == "Seq Scan" || read > limit as f64 {
            failures.push(format!(
                "{case}: Mention reads not bounded by the page ({} reading {read} rows)",
                node["Node Type"]
            ));
        }
    }
    let ([log], [message]) = (log.as_slice(), messages.as_slice()) else {
        failures.push(format!(
            "{case}: expected one scan each of channel_log and messages: {root}"
        ));
        return;
    };

    let log_index = log["Index Cond"].as_str().unwrap_or_default();
    let message_index = message["Index Cond"].as_str().unwrap_or_default();
    let positions = log["Actual Rows"].as_f64().unwrap();
    let rows = message["Actual Rows"].as_f64().unwrap();
    let loops = message["Actual Loops"].as_f64().unwrap();
    let total = rows * loops;
    // The root includes child buffers, so summing all nodes would double-count.
    let buffers =
        root["Shared Hit Blocks"].as_i64().unwrap() + root["Shared Read Blocks"].as_i64().unwrap();
    let temp_read = root["Temp Read Blocks"].as_i64().unwrap();
    let temp_write = root["Temp Written Blocks"].as_i64().unwrap();
    // Allow headroom for extra index levels and the access and Mention reads.
    let buffer_cap = 32 * limit;
    eprintln!(
        "{case}: {positions} positions, Message rows {rows} x {loops} = {total}, shared buffers {buffers}, temp blocks {temp_read}/{temp_write}"
    );
    let checks = [
        (
            positions == limit as f64 && log["Actual Loops"] == 1,
            format!(
                "expected {limit} log positions in one scan, got {positions} x {}",
                log["Actual Loops"]
            ),
        ),
        (
            log_index.contains("event_seq > ") && log_index.contains("event_seq <= "),
            format!("missing sequence bounds in channel_log Index Cond: {log_index}"),
        ),
        (
            ["organization_id", "channel_id", "id"]
                .iter()
                .all(|column| message_index.contains(&format!("({column} = "))),
            format!("missing Message key columns in messages Index Cond: {message_index}"),
        ),
        (
            rows <= 1.0,
            format!("Message rows per loop {rows} exceed 1"),
        ),
        (
            total <= positions,
            format!("total Message rows {total} exceed {positions} page positions"),
        ),
        (
            buffers < buffer_cap,
            format!("shared buffers {buffers} reach or exceed {buffer_cap}"),
        ),
        (
            temp_read == 0 && temp_write == 0,
            format!("temp blocks read/written {temp_read}/{temp_write}"),
        ),
    ];
    failures.extend(
        checks
            .into_iter()
            .filter(|(passed, _)| !passed)
            .map(|(_, detail)| format!("{case}: {detail}")),
    );
}

#[fukulow_test::test]
async fn authorized_page_plans_generically_without_leaking_the_setting(pool: PgPool) {
    let org = organization(&pool).await;
    let (sender, outsider) = (Uuid::new_v4(), Uuid::new_v4());
    member(&pool, org, sender).await;
    member(&pool, org, outsider).await;
    let (public, private) = (Uuid::new_v4(), Uuid::new_v4());
    channel(&pool, org, public, sender, false).await;
    channel(&pool, org, private, sender, true).await;
    for id in [public, private] {
        sqlx::query(
            "INSERT INTO messages (organization_id, channel_id, sender, id, seq, client_message_id, body) \
             SELECT $1, $2, $3, gen_random_uuid(), n, gen_random_uuid(), 'plan' FROM generate_series(1, 3) n",
        )
        .bind(org).bind(id).bind(sender).execute(&pool).await.unwrap();
    }
    seed_channel_log(&pool).await;
    let app = crate::test_app_pool(pool.clone()).await;
    // One connection, so every check below observes the page's own backend.
    let single = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with((*app.connect_options()).clone())
        .await
        .unwrap();
    for _ in 0..3 {
        let page = crate::messages::authorized_replay_page(&single, org, (sender, 0), public, 0, 3)
            .await
            .unwrap();
        assert_eq!(
            page.iter().map(|event| event.seq).collect::<Vec<_>>(),
            [1, 2, 3]
        );
    }
    // A private Channel non-member is still denied; the denial also ends the setting.
    assert!(matches!(
        crate::messages::authorized_replay_page(&single, org, (outsider, 0), private, 0, 3).await,
        Err(crate::messages::MessageError::NotFound)
    ));
    let mut conn = single.acquire().await.unwrap();
    let state: (String, String, bool) = sqlx::query_as(
        "SELECT current_setting('plan_cache_mode'), current_setting('transaction_read_only'), \
                current_setting('fukulow.organization_id', true) IS NULL \
                OR current_setting('fukulow.organization_id', true) = ''",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert_eq!(state, ("auto".into(), "off".into(), true));
    let plans: (i64, i64) = sqlx::query_as(
        "SELECT generic_plans, custom_plans FROM pg_prepared_statements WHERE statement LIKE '%log_page%'",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert_eq!(plans, (4, 0));
    drop(conn);
    single.close().await;
    app.close().await;
}
