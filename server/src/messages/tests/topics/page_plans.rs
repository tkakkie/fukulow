use super::*;
use crate::messages::topics::projection::{page_sql, reference};

fn page_scans<'a>(plan: &'a Value, scans: &mut Vec<&'a Value>) {
    if matches!(plan["Relation Name"].as_str(), Some("messages" | "topics"))
        && plan["Actual Loops"].as_u64().unwrap_or(0) > 0
    {
        scans.push(plan);
    }
    if let Some(children) = plan["Plans"].as_array() {
        for child in children {
            page_scans(child, scans);
        }
    }
}

async fn explain(tx: &mut sqlx::PgConnection, execute: &str) -> Value {
    let explain: Value = sqlx::query_scalar(&format!(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {execute}"
    ))
    .fetch_one(tx)
    .await
    .unwrap();
    explain[0]["Plan"].clone()
}

#[fukulow_test::test]
async fn topic_pages_bound_message_and_topic_buffers_in_both_plan_modes(pool: PgPool) {
    let org = organization(&pool).await;
    let sender = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    member(&pool, org, sender).await;
    member(&pool, org, viewer).await;
    let channel_id = Uuid::new_v4();
    channel(&pool, org, channel_id, sender, false).await;
    let topic = Uuid::new_v4();
    // Sparse main timeline (including a tombstone), a long Topic prefix, many
    // one-Message Topics, and a short append suffix on both old and new Topics.
    sqlx::query(
        "INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count)
        VALUES ($1,$2,$3,'Long',5,60004,55001)",
    )
    .bind(org)
    .bind(channel_id)
    .bind(topic)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count)
        SELECT $1,$2,md5(n::text)::uuid,n::text,n,n,1 FROM generate_series(55005,60003) n",
    )
    .bind(org)
    .bind(channel_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id,deleted)
        SELECT $1,gen_random_uuid(),$2,n,$3,gen_random_uuid(),repeat('x',200),
            CASE WHEN n<=4 THEN NULL WHEN n BETWEEN 55005 AND 60003 THEN md5(n::text)::uuid ELSE $4 END,n=4
        FROM generate_series(1,60004) n")
        .bind(org).bind(channel_id).bind(sender).bind(topic).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences (organization_id,channel_id,seq) VALUES($1,$2,60004)")
        .bind(org).bind(channel_id).execute(&pool).await.unwrap();
    for table in ["topics", "messages", "message_append_counts"] {
        sqlx::query(&format!("ANALYZE {table}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let reader = crate::test_app_pool(pool).await;
    let mut tx = reader.begin().await.unwrap();
    crate::database::set_organization(&mut tx, org)
        .await
        .unwrap();
    sqlx::raw_sql(&format!(
        "SET LOCAL jit=off;
         PREPARE page_before AS {};
         PREPARE page_after AS {};",
        reference::page_sql(),
        page_sql()
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    for mode in ["force_custom_plan", "force_generic_plan"] {
        sqlx::query(&format!("SET LOCAL plan_cache_mode={mode}"))
            .execute(&mut *tx)
            .await
            .unwrap();
        for (label, w, before, topics_only, filter) in [
            ("latest", 60004, "NULL", false, "NULL".into()),
            ("older", 60000, "60000", false, "NULL".into()),
            ("deep", 60000, "55005", false, "NULL".into()),
            ("filtered", 60000, "NULL", true, format!("'{topic}'")),
        ] {
            let args = format!(
                "('{org}','{viewer}',0,'{channel_id}',{w},{before},3,{topics_only},{filter})"
            );
            let old = explain(&mut tx, &format!("EXECUTE page_before{args}")).await;
            let new = explain(&mut tx, &format!("EXECUTE page_after{args}")).await;
            let buffers = |plan: &Value| {
                plan["Shared Hit Blocks"].as_u64().unwrap()
                    + plan["Shared Read Blocks"].as_u64().unwrap()
            };
            let mut scans = Vec::new();
            page_scans(&new, &mut scans);
            eprintln!(
                "{mode} {label}: old={} new={} buffers; scans: {:?}",
                buffers(&old),
                buffers(&new),
                scans
                    .iter()
                    .map(|scan| (
                        &scan["Relation Name"],
                        &scan["Index Name"],
                        &scan["Index Cond"],
                        buffers(scan)
                    ))
                    .collect::<Vec<_>>()
            );
            assert!(buffers(&old) > 1_000, "{mode} {label}: {old}");
            assert!(buffers(&new) < 200, "{mode} {label}: {new}");
            assert!(
                scans.iter().all(|scan| scan["Index Cond"].is_string()),
                "{mode} {label}: {new}"
            );
        }
    }
}
