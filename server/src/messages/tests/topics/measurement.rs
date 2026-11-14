use super::*;
use std::time::Instant;

fn report(kind: &str, boundary: Option<i64>, samples: &mut [f64]) -> f64 {
    samples.sort_by(f64::total_cmp);
    let p95 = samples[(samples.len() * 95).div_ceil(100) - 1];
    eprintln!(
        "TOPIC_{kind} boundary={boundary:?} n={} p50_ms={:.3} p95_ms={p95:.3} max_ms={:.3}",
        samples.len(),
        samples[(samples.len() / 2).saturating_sub(1)],
        samples[samples.len() - 1]
    );
    p95
}

// Preselected gate: p95 <=100 ms, four readers, 50 items, recent/deep, while
// sending. Scale controls a second point for extrapolation, never query limits.
#[fukulow_test::test]
#[ignore = "manual release paging feasibility gate; run without other tests/builds"]
async fn measure_topic_projection_pages(pool: PgPool) {
    let topics: i64 = std::env::var("MEASURE_TOPICS")
        .map(|s| s.parse().unwrap())
        .unwrap_or(10000);
    let w = topics * 20;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let (app, org, sender, channel, token) = fixture(&pool).await;
    sqlx::query(
        "INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) \
        SELECT $1,$2,gen_random_uuid(),'Topic '||n,2*n-1,$3*20+n,11 FROM generate_series(1,$3) n",
    )
    .bind(org)
    .bind(channel)
    .bind(topics)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) \
        SELECT $1,gen_random_uuid(),$2,CASE WHEN k=10 THEN $4*20+substring(name FROM 7)::bigint \
        ELSE 2*substring(name FROM 7)::bigint-1+k*$4*2 END,$3,gen_random_uuid(),'measurement',id \
        FROM topics CROSS JOIN generate_series(0,10) k WHERE organization_id=$1 AND channel_id=$2")
        .bind(org).bind(channel).bind(sender).bind(topics).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body) \
        SELECT $1,gen_random_uuid(),$2,2*n,$3,gen_random_uuid(),'plain measurement' FROM generate_series(1,$4*10) n")
        .bind(org).bind(channel).bind(sender).bind(topics).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO channel_message_sequences VALUES ($1,$2,$3)")
        .bind(org)
        .bind(channel)
        .bind(w + topics)
        .execute(&pool)
        .await
        .unwrap();
    // Refresh planner statistics without forcing heap visibility/index-only scans.
    sqlx::query("ANALYZE messages")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("ANALYZE topics").execute(&pool).await.unwrap();
    eprintln!(
        "TOPIC_DATA topics={topics} pre_w_topic_messages={} plain_messages={} w={w} initial_channel_messages={} readers=4 send_interval_ms=50",
        topics * 10,
        topics * 10,
        w + topics
    );
    let mut passed = true;
    for boundary in [None, Some(w - topics)] {
        let suffix = format!(
            "timeline?as_of_seq={w}&limit=50{}",
            boundary
                .map(|p| format!("&before_position={p}"))
                .unwrap_or_default()
        );
        for _ in 0..10 {
            get(&app, &token, channel, &suffix).await;
        }
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let sends = {
            let app = app.clone();
            let token = token.clone();
            tokio::spawn(async move {
                let mut samples = Vec::new();
                let mut tick = tokio::time::interval(std::time::Duration::from_millis(50));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = stopped.changed() => break,
                        _ = tick.tick() => {}
                    }
                    let start = Instant::now();
                    sent(
                        &app,
                        &token,
                        channel,
                        topic_input(Uuid::new_v4(), "Topic 1"),
                    )
                    .await;
                    samples.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                samples
            })
        };
        let start = Instant::now();
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
                    assert_eq!(page["as_of_seq"], w);
                    let items = page["items"].as_array().unwrap();
                    assert_eq!(items.len(), 50);
                    let last = boundary.map(|p| p - 1).unwrap_or(w);
                    for (index, item) in items.iter().enumerate() {
                        let position = last - 49 + index as i64;
                        if position % 2 == 0 {
                            assert_eq!(item["message"]["seq"], position);
                        } else {
                            assert_eq!(item["topic"]["last_seq"], position);
                            assert_eq!(item["topic"]["message_count"], 10);
                        }
                    }
                }
                elapsed
            });
        }
        let mut samples = Vec::new();
        while let Some(result) = workers.join_next().await {
            samples.extend(result.unwrap());
        }
        stop.send(true).unwrap();
        let mut send_samples = sends.await.unwrap();
        eprintln!(
            "TOPIC_WINDOW boundary={boundary:?} seconds={:.3} send_rate_per_s={:.3}",
            start.elapsed().as_secs_f64(),
            send_samples.len() as f64 / start.elapsed().as_secs_f64()
        );
        passed &= report("PAGE", boundary, &mut samples) <= 100.0;
        report("SEND", boundary, &mut send_samples);
    }
    assert!(passed, "feasibility gate missed: stop; do not add a limit");
}
