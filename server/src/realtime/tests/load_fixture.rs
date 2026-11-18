use super::*;

// Load fixtures insert Messages directly (load/channel-log.sql). Their replay
// from after_seq 0 must complete once the shared Create-log step has run.
const CREATE_LOG: &str = include_str!("../../../../load/channel-log.sql");

async fn append_create_log(pool: &PgPool, f: &Fixture) -> u64 {
    sqlx::query(CREATE_LOG)
        .bind(f.organization)
        .bind(vec![f.channel])
        .execute(pool)
        .await
        .unwrap()
        .rows_affected()
}

#[fukulow_test::test]
async fn directly_seeded_history_replays_from_zero_after_fixture_create_log(pool: PgPool) {
    let f = fixture(&pool).await;
    for statement in [
        "INSERT INTO channel_message_sequences (organization_id, channel_id, seq) \
         SELECT $1, $2, 120 WHERE $3::uuid IS NOT NULL",
        "INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body) \
         SELECT $1, gen_random_uuid(), $2, n, $3, gen_random_uuid(), 'seed' FROM generate_series(1, 120) n",
    ] {
        sqlx::query(statement)
            .bind(f.organization)
            .bind(f.channel)
            .bind(f.member)
            .execute(&pool)
            .await
            .unwrap();
    }
    // Control: without the Create log the replay fails closed.
    let mut missing = f.server.connect(&f.token).await;
    subscribe(&mut missing, f.channel, 0).await;
    closed(&mut missing, 1011).await;

    assert_eq!(append_create_log(&pool, &f).await, 120);
    assert_eq!(append_create_log(&pool, &f).await, 0);
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    for seq in 1..=120 {
        assert_eq!(event(&mut socket).await["message"]["created_seq"], seq);
    }
    ready(&mut socket, f.channel, 120).await;
    let live = post(&f, f.channel).await;
    assert_eq!(live["created_seq"], 121);
    assert_eq!(event(&mut socket).await["message"], live);
}
