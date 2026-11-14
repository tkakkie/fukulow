use super::*;
use std::time::Instant;

#[fukulow_test::test]
#[ignore = "manual Reply chain cost gate; run in release without concurrent builds/tests"]
async fn measure_reply_chain_pages(pool: PgPool) {
    // Target stated before measuring: warm p95 <100 ms, 200 rows, 10k deep/wide.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(20)
        .connect_with((*pool.connect_options()).clone())
        .await
        .unwrap();
    let (app, org, sender, channel, token) = fixture(&pool).await;
    let mut passed = true;
    for (shape, offset) in [("deep", 0_i64), ("wide", 110011)] {
        let ids = (0..=10000).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
        let root = ids[0];
        let parents = ids
            .iter()
            .enumerate()
            .map(|(n, _)| {
                if n == 0 {
                    None
                } else {
                    Some(if shape == "deep" { ids[n - 1] } else { root })
                }
            })
            .collect::<Vec<_>>();
        sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,reply_to_id,reply_root_id) SELECT $1,$2,id,$6+(n-1)*11+1,$3,gen_random_uuid(),'measurement',parent,CASE WHEN n=1 THEN NULL ELSE $7 END FROM unnest($4::uuid[],$5::uuid[]) WITH ORDINALITY v(id,parent,n)")
            .bind(org).bind(channel).bind(sender).bind(&ids).bind(&parents).bind(offset).bind(root).execute(&pool).await.unwrap();
        // Ten unrelated roots between chain entries expose accidental Channel scans.
        sqlx::query("INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body) SELECT $1,$2,gen_random_uuid(),$4+n*11+k,$3,gen_random_uuid(),'unrelated measurement' FROM generate_series(0,10000) n CROSS JOIN generate_series(2,11) k")
            .bind(org).bind(channel).bind(sender).bind(offset).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO channel_message_sequences VALUES ($1,$2,$3) ON CONFLICT (organization_id,channel_id) DO UPDATE SET seq=EXCLUDED.seq").bind(org).bind(channel).bind(offset+110011).execute(&pool).await.unwrap();
        sqlx::query("ANALYZE messages")
            .execute(&pool)
            .await
            .unwrap();
        for relative_after in [0_i64, 5000, 9801] {
            let after = offset + relative_after * 11;
            let query = format!("?after_seq={after}&limit=200");
            for _ in 0..10 {
                page(&app, &token, channel, ids[10000], &query).await;
            }
            let mut workers = tokio::task::JoinSet::new();
            for _ in 0..4 {
                let (app, token, query) = (app.clone(), token.clone(), query.clone());
                let anchor = ids[10000];
                workers.spawn(async move {
                    let mut samples = Vec::new();
                    for _ in 0..100 {
                        let start = Instant::now();
                        let p = page(&app, &token, channel, anchor, &query).await;
                        samples.push(start.elapsed().as_secs_f64() * 1000.0);
                        assert_eq!(p["root_id"], root.to_string());
                        assert_eq!(p["messages"].as_array().unwrap().len(), 200);
                        assert_eq!(p["messages"][0]["seq"], after + 1);
                        assert_eq!(
                            p["messages"][199]["seq"],
                            offset + (relative_after + 199) * 11 + 1
                        );
                        assert_eq!(p["has_more"], relative_after != 9801);
                    }
                    samples
                });
            }
            let mut samples = Vec::new();
            while let Some(r) = workers.join_next().await {
                samples.extend(r.unwrap());
            }
            samples.sort_by(f64::total_cmp);
            let p95 = samples[379];
            passed &= p95 < 100.0;
            eprintln!(
                "REPLY_CHAIN shape={shape} descendants=10000 channel_messages={} after={relative_after} workers=4 n=400 p50_ms={:.3} p95_ms={p95:.3} max_ms={:.3}",
                offset + 110011,
                samples[199],
                samples[399]
            );
            let plan: Value = sqlx::query_scalar(&format!(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}",
                super::super::super::replies::PAGE_SQL
            ))
            .bind(org)
            .bind(channel)
            .bind(root)
            .bind(after)
            .bind(201_i64)
            .bind(offset + 110011)
            .fetch_one(&pool)
            .await
            .unwrap();
            let plan = plan.to_string();
            assert!(plan.contains("messages_reply_chain_seq"), "{plan}");
            eprintln!("REPLY_CHAIN_PLAN shape={shape} after={relative_after} {plan}");
        }
    }
    assert!(passed, "Reply chain latency gate missed");
}
