use super::*;

async fn nil_rows(pool: &PgPool, org: Uuid, channel: Uuid) -> Vec<(Uuid, i64)> {
    sqlx::query_as(
        "SELECT scope_id,appended FROM message_append_counts
        WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 ORDER BY scope_id",
    )
    .bind(org)
    .bind(channel)
    .bind(Uuid::nil())
    .fetch_all(pool)
    .await
    .unwrap()
}

#[fukulow_test::test(migrations = false)]
async fn scope_total_migration_backfills_and_rollback_restores_nil_rows(pool: PgPool) {
    let migrations = sqlx::migrate!();
    let mut previous = sqlx::migrate!();
    previous
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 202611271100);
    previous.run(&pool).await.unwrap();

    let (app, org, sender, channel, token) = fixture(&pool).await;
    historical_post(&pool, org, sender, channel, None).await;
    historical_post(&pool, org, sender, channel, Some("Existing")).await;
    let old = nil_rows(&pool, org, channel).await;
    assert_eq!(old.len(), 2);
    assert_eq!(old[0], (Uuid::nil(), 1));
    assert_eq!(old[1].1, 1);
    let viewer = member(&pool, org, Uuid::new_v4()).await;
    migrations.run(&pool).await.unwrap();
    assert!(nil_rows(&pool, org, channel).await.is_empty());
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT s.main_appended,t.scope_appended FROM channel_message_sequences s
             JOIN topics t USING (organization_id,channel_id)
             WHERE s.organization_id=$1 AND s.channel_id=$2 AND t.id=$3"
        )
        .bind(org)
        .bind(channel)
        .bind(old[1].0)
        .fetch_one(&pool)
        .await
        .unwrap(),
        (1, 1)
    );

    // Both parts of each total are populated at rollback, with a persisted
    // Topic position and a correction that must survive.
    post(&app, &token, channel, None).await;
    post(&app, &token, channel, Some("Existing")).await;
    historical_post(&pool, org, sender, channel, None).await;
    historical_post(&pool, org, sender, channel, Some("Existing")).await;
    mark(&app, &viewer, channel, Some(&old[1].0.to_string()), 2).await;
    sqlx::query(
        "UPDATE messages SET deleted=true WHERE organization_id=$1 AND channel_id=$2 AND seq=4",
    )
    .bind(org)
    .bind(channel)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(nil_rows(&pool, org, channel).await, old);
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM message_counts_check($1)")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(before, 0);

    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../../../load/sql-probes/519-unread-counts/sql/f2-rollback.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        nil_rows(&pool, org, channel).await,
        vec![(old[0].0, 3), (old[1].0, 3)]
    );
    historical_post(&pool, org, sender, channel, None).await;
    assert_eq!(
        nil_rows(&pool, org, channel).await,
        vec![(old[0].0, 4), (old[1].0, 3)]
    );
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM message_counts_check($1)")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(after, 0);
}
