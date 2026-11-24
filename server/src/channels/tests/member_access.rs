use super::*;
use crate::{database, test_support::TestPools};
use std::time::Duration;

#[fukulow_test::test]
async fn member_access_batches_keep_scoped_current_revisions_without_row_locks(pool: PgPool) {
    let pools = TestPools::new(pool).await;
    let org = organization(&pools.admin).await;
    let foreign_org = organization(&pools.admin).await;
    let reader = Uuid::new_v4();
    let ungranted = Uuid::new_v4();
    let foreign = Uuid::new_v4();
    let token = member(&pools.admin, org, reader, "member").await;
    member(&pools.admin, org, ungranted, "owner").await;
    member(&pools.admin, foreign_org, reader, "member").await;
    member(&pools.admin, foreign_org, foreign, "member").await;
    let channel: Uuid = serde_json::from_value(
        create(&router(&pools.admin).await, &token, "Private", "private").await["id"].clone(),
    )
    .unwrap();

    let mut writer = pools.admin.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE organization_id=$1 AND id=$2 FOR UPDATE")
        .bind(org)
        .bind(reader)
        .fetch_one(&mut *writer)
        .await
        .unwrap();
    sqlx::query(
        "SELECT member_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 FOR UPDATE",
    )
    .bind(org)
    .bind(channel)
    .bind(reader)
    .fetch_one(&mut *writer)
    .await
    .unwrap();

    let candidates = [(reader, 0), (reader, 1), (ungranted, 0), (foreign, 0)];
    let mut expected = [(reader, 0, true), (ungranted, 0, false)];
    expected.sort_unstable();
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut rows = member_access(&pools.app, org, channel, &candidates)
            .await
            .unwrap();
        rows.sort_unstable();
        assert_eq!(rows, expected);

        let mut rows = database::organization_read_only(&pools.app, org, async |tx| {
            member_access_in(tx, org, channel, &candidates).await
        })
        .await
        .unwrap();
        rows.sort_unstable();
        assert_eq!(rows, expected);

        assert_eq!(
            is_visible_scoped(&pools.app, org, (reader, 0), channel)
                .await
                .unwrap(),
            Some(true)
        );
        assert_eq!(
            is_visible_scoped(&pools.app, foreign_org, (reader, 0), channel)
                .await
                .unwrap(),
            Some(false)
        );
    })
    .await
    .expect("read authorization waits for neither the Member nor the grant row");
    writer.rollback().await.unwrap();
}
