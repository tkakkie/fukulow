use super::super::archive::{placements, set_archived};
use super::*;

async fn assert_channel_locked(f: &Fixture, channel: Uuid) {
    let error = sqlx::query(
        "SELECT id FROM channels WHERE organization_id=$1 AND id=$2 FOR NO KEY UPDATE NOWAIT",
    )
    .bind(f.owner.org)
    .bind(channel)
    .fetch_one(&f.pools.admin)
    .await
    .unwrap_err();
    assert_eq!(
        error
            .as_database_error()
            .and_then(|error| error.code())
            .as_deref(),
        Some("55P03")
    );
}

#[fukulow_test::test]
async fn placement_move_and_archive_serialize_in_both_orders(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let group = Uuid::new_v4();
    f.create(group, "Destination").await;
    let channel = f.channel("Racing", "public").await;
    let placement = placement_path(channel);
    let metadata = format!("/channels/{channel}");
    let before = f.get(SECTIONS).await;

    let table = "member_section_placements";
    let blocker = pause(&f, "INSERT", table).await;
    let moving = spawn(&f, "PUT", &placement, &f.token, json!({"section_id":group}));
    wait_blocked(&f, "INSERT INTO member_section_placements%").await;
    assert_channel_locked(&f, channel).await;
    let archiving = spawn(&f, "PATCH", &metadata, &f.token, json!({"archived":true}));
    // Archive takes the exclusive Organization row lock before the Channel lock.
    wait_blocked(&f, ORG_EXCLUSIVE).await;
    assert_eq!(f.get(SECTIONS).await, before);
    blocker.commit().await.unwrap();
    expected(joined(moving).await, StatusCode::NO_CONTENT).await;
    expected(joined(archiving).await, StatusCode::NO_CONTENT).await;
    unpause(&f, table).await;
    assert_eq!(placements(&f).await, vec![(channel, Some(group), 0)]);
    let archived_layout = f.get(SECTIONS).await;
    assert_eq!(archived_layout["generation"], "2");
    assert_eq!(archived_layout["sections"][0]["channel_ids"], json!([]));
    set_archived(&f, &f.token, channel, false).await;

    let before = f.get(SECTIONS).await;
    assert_eq!(before["sections"][0]["channel_ids"], json!([channel]));
    let stored = placements(&f).await;
    let blocker = pause(&f, "UPDATE OF archived_at", "channels").await;
    let archiving = spawn(&f, "PATCH", &metadata, &f.token, json!({"archived":true}));
    wait_blocked(&f, "%UPDATE channels SET archived_at%").await;
    assert_channel_locked(&f, channel).await;
    let moving = spawn(&f, "PUT", &placement, &f.token, json!({"section_id":null}));
    wait_blocked(&f, ORG_SHARE).await;
    assert_eq!(f.get(SECTIONS).await, before);
    blocker.commit().await.unwrap();
    expected(joined(archiving).await, StatusCode::NO_CONTENT).await;
    denied(
        joined(moving).await,
        StatusCode::CONFLICT,
        "channel_archived",
    )
    .await;
    unpause(&f, "channels").await;
    assert_eq!(f.get(SECTIONS).await, archived_layout);
    assert_eq!(placements(&f).await, stored);
}
