use super::*;
use std::time::Instant;

// Preselected before measurement: p95 <=100 ms at concurrency 4, 50-item pages,
// 10,000 Topics / 100,000 pre-W Messages, every Topic moved after W, recent/deep.
#[sqlx::test]
#[ignore = "manual release paging feasibility gate; run without other tests/builds"]
async fn measure_topic_projection_pages(pool: PgPool) {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let (app, org, sender, channel, token) = fixture(&pool).await;
    sqlx::query(
        "INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) \
        SELECT $1,$2,gen_random_uuid(),'Topic '||n,n,100000+n,11 FROM generate_series(1,10000) n",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) \
        SELECT $1,gen_random_uuid(),$2,substring(name FROM 7)::bigint + k*10000,$3,gen_random_uuid(),'measurement',id \
        FROM topics CROSS JOIN generate_series(0,10) k WHERE organization_id=$1 AND channel_id=$2")
        .bind(org).bind(channel).bind(sender).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences VALUES ($1,$2,110000)")
        .bind(org)
        .bind(channel)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("VACUUM ANALYZE messages")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("ANALYZE topics").execute(&pool).await.unwrap();
    for boundary in [None, Some(95001)] {
        let suffix = format!(
            "timeline?as_of_seq=100000&limit=50{}",
            boundary
                .map(|p| format!("&before_position={p}"))
                .unwrap_or_default()
        );
        for _ in 0..10 {
            get(&app, &token, channel, &suffix).await;
        }
        let mut workers = tokio::task::JoinSet::new();
        for _ in 0..4 {
            let app = app.clone();
            let token = token.clone();
            let suffix = suffix.clone();
            workers.spawn(async move {
                let mut elapsed = Vec::new();
                for _ in 0..100 {
                    let start = Instant::now();
                    let page = get(&app, &token, channel, &suffix).await;
                    elapsed.push(start.elapsed().as_secs_f64() * 1000.0);
                    assert_eq!(page["as_of_seq"], 100000);
                    let items = page["items"].as_array().unwrap();
                    assert_eq!(items.len(), 50);
                    assert_eq!(
                        items[0]["topic"]["last_seq"],
                        boundary.unwrap_or(100001) - 50
                    );
                    for item in items {
                        assert_eq!(item["topic"]["message_count"], 10);
                    }
                }
                elapsed
            });
        }
        let mut samples = Vec::new();
        while let Some(result) = workers.join_next().await {
            samples.extend(result.unwrap());
        }
        samples.sort_by(f64::total_cmp);
        let p95 = samples[379];
        eprintln!(
            "TOPIC_PAGE boundary={boundary:?} n={} concurrency=4 p50_ms={:.3} p95_ms={p95:.3} max_ms={:.3} target_ms=100",
            samples.len(),
            samples[199],
            samples[399]
        );
        assert!(
            p95 <= 100.0,
            "feasibility gate missed: stop; do not add a limit"
        );
    }
}
