use super::*;

async fn provision_members(pool: &PgPool, organization: Uuid, count: usize) {
    sqlx::query("WITH added AS (INSERT INTO accounts (id,email,password_hash) SELECT gen_random_uuid(), gen_random_uuid()::text || '@measure.invalid','unused' FROM generate_series(1,$2::int) RETURNING id) INSERT INTO users (organization_id,id,account_id,name,role) SELECT $1,gen_random_uuid(),id,'Member','member' FROM added")
        .bind(organization).bind((count - 1) as i32).execute(pool).await.unwrap();
    sqlx::raw_sql("ANALYZE users; ANALYZE channels; ANALYZE channel_members")
        .execute(pool)
        .await
        .unwrap();
}

async fn sql_counts(pool: &PgPool) -> HashMap<String, i64> {
    sqlx::query_as::<_, (String,i64)>("SELECT query,calls FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND toplevel AND query NOT LIKE '%pg_stat_statements%'")
        .fetch_all(pool).await.unwrap().into_iter().collect()
}

fn cpu_seconds() -> f64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "time=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    let text = String::from_utf8(output.stdout).unwrap();
    let parts: Vec<f64> = text.trim().split(':').map(|s| s.parse().unwrap()).collect();
    parts
        .into_iter()
        .fold(0.0, |total, part| total * 60.0 + part)
}

// Focused release probe, not the item 6 offered-load/capacity scenario.
#[sqlx::test]
#[ignore = "manual release fan-out/reorder SQL, latency and combined server/client CPU measurement"]
async fn measure_fanout_and_reorder(pool: PgPool) {
    sqlx::query("CREATE EXTENSION pg_stat_statements")
        .execute(&pool)
        .await
        .unwrap();
    let active: usize = std::env::var("MEASURE_MEMBERS")
        .unwrap_or_else(|_| "1".into())
        .parse()
        .unwrap();
    let subscribers: usize = std::env::var("MEASURE_SUBSCRIBERS")
        .unwrap_or_else(|_| "128".into())
        .parse()
        .unwrap();
    let f = fixture(&pool).await;
    provision_members(&pool, f.organization, active).await;
    let mut sockets = Vec::new();
    for _ in 0..subscribers {
        let mut socket = f.server.connect(&f.token).await;
        subscribe(&mut socket, f.channel, 0).await;
        ready(&mut socket, f.channel, 0).await;
        sockets.push(socket);
    }
    let before = sql_counts(&pool).await;
    let cpu = cpu_seconds();
    let start = std::time::Instant::now();
    let mut latency = Vec::new();
    for _ in 0..200 {
        let start = std::time::Instant::now();
        let sent = post(&f, f.channel).await;
        for socket in &mut sockets {
            assert_eq!(event(socket).await["message"], sent);
        }
        latency.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    f.state.message_delivery.flush().await;
    let elapsed = start.elapsed().as_secs_f64();
    let cpu = cpu_seconds() - cpu;
    let after = sql_counts(&pool).await;
    let mut total = 0;
    for (query, calls) in &after {
        let delta = calls - before.get(query).copied().unwrap_or_default();
        if delta > 0 {
            total += delta;
            eprintln!("FANOUT_SQL calls={delta} query={query}");
        }
    }
    latency.sort_by(f64::total_cmp);
    eprintln!(
        "FANOUT members={active} subscribers={subscribers} sends=200 elapsed_s={elapsed:.6} cpu_s={cpu:.3} statements_per_send={} latency_ms_median={:.3} p95={:.3}",
        total as f64 / 200.0,
        latency[100],
        latency[190]
    );
    let key = Uuid::new_v4();
    let gate = messages::pause_publication(key);
    send(&f, &f.token, f.channel, key, "held first").await;
    tokio::time::timeout(Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let before = sql_counts(&pool).await;
    let start = std::time::Instant::now();
    let sent = post(&f, f.channel).await;
    for socket in &mut sockets {
        assert_eq!(
            event(socket).await["message"]["client_message_id"],
            json!(key)
        );
        assert_eq!(event(socket).await["message"], sent);
    }
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    gate.release.add_permits(1);
    f.state.message_delivery.flush().await;
    let after = sql_counts(&pool).await;
    let mut total = 0;
    for (query, calls) in &after {
        let delta = calls - before.get(query).copied().unwrap_or_default();
        if delta > 0 {
            total += delta;
            eprintln!("REORDER_SQL calls={delta} query={query}");
        }
    }
    eprintln!(
        "REORDER members={active} subscribers={subscribers} statements={total} latency_ms={elapsed:.3}"
    );
}
