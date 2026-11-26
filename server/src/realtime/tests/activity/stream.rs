use super::*;

#[fukulow_test::test]
async fn activity_ready_is_the_first_event_after_registration(pool: PgPool) {
    let f = fixture(&pool).await;
    let mut socket = f.server.connect(&f.token).await;
    subscribe(&mut socket, f.channel, 0).await;
    assert_eq!(
        raw_event(&mut socket).await,
        json!({"type":"activity_ready"})
    );
    assert_eq!(raw_event(&mut socket).await["type"], "subscribed");
}

#[fukulow_test::test]
async fn more_than_256_visible_channels_receive_unwatched_activity_without_message_bodies(
    pool: PgPool,
) {
    let f = fixture(&pool).await;
    let (_, reader) = member(&pool, f.organization).await;
    let mut last = f.channel;
    for _ in 0..257 {
        last = channel(&pool, f.organization, f.member, false).await;
    }
    let mut socket = connect(&f, &reader).await;
    subscribe(&mut socket, f.channel, 0).await;
    assert_eq!(raw_event(&mut socket).await["type"], "subscribed");
    post(&f, last).await;
    assert_eq!(notices(&f, &mut socket).await, vec![activity(last, 1)]);
}
