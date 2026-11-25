use super::*;
use std::time::Duration;

#[fukulow_test::test]
async fn search_reads_scopes_and_bodies_while_member_and_grant_rows_are_locked(pool: PgPool) {
    let f = Fixture::new(pool).await;
    let private = f.channel(true).await;
    let hit = id(&f.post(private, "needle").await);

    let mut writer = f.pools.admin.begin().await.unwrap();
    sqlx::query("SELECT id FROM users WHERE organization_id=$1 AND id=$2 FOR UPDATE")
        .bind(f.org)
        .bind(f.author)
        .fetch_one(&mut *writer)
        .await
        .unwrap();
    sqlx::query(
        "SELECT member_id FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 FOR UPDATE",
    )
    .bind(f.org)
    .bind(private)
    .bind(f.author)
    .fetch_one(&mut *writer)
    .await
    .unwrap();

    let result = tokio::time::timeout(
        Duration::from_secs(2),
        page(&f, &f.token, "needle", Some(private), None),
    )
    .await
    .expect("search waits for neither the Member nor the grant row");
    assert_eq!(ids(&result), [hit]);
    writer.rollback().await.unwrap();
}
