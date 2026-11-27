use super::*;

#[fukulow_test::test]
async fn directly_seeded_messages_replay_from_zero_and_handoff_to_live(pool: PgPool) {
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
