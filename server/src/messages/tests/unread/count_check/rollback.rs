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

async fn migrate_before_f2(pool: &PgPool) {
    let mut previous = sqlx::migrate!();
    previous
        .migrations
        .to_mut()
        .retain(|migration| migration.version < 202611271100);
    previous.run(pool).await.unwrap();
}

async fn rollback_f2(pool: &PgPool) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../../../load/sql-probes/519-unread-counts/sql/f2-rollback.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
}

async fn assert_recount_clean(pool: &PgPool, org: Uuid) {
    let differences: Vec<Discrepancy> = sqlx::query_as("SELECT * FROM message_counts_check($1)")
        .bind(org)
        .fetch_all(pool)
        .await
        .unwrap();
    assert!(differences.is_empty(), "{differences:?}");
}

#[fukulow_test::test(migrations = false)]
async fn scope_total_migration_backfills_and_rollback_restores_nil_rows(pool: PgPool) {
    migrate_before_f2(&pool).await;

    let (app, org, sender, channel, token) = fixture(&pool).await;
    historical_post(&pool, org, sender, channel, None).await;
    historical_post(&pool, org, sender, channel, Some("Existing")).await;
    let old = nil_rows(&pool, org, channel).await;
    assert_eq!(old.len(), 2);
    assert_eq!(old[0], (Uuid::nil(), 1));
    assert_eq!(old[1].1, 1);
    let viewer = member(&pool, org, Uuid::new_v4()).await;
    sqlx::migrate!().run(&pool).await.unwrap();
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
    assert_recount_clean(&pool, org).await;

    rollback_f2(&pool).await;
    assert_eq!(
        nil_rows(&pool, org, channel).await,
        vec![(old[0].0, 3), (old[1].0, 3)]
    );
    historical_post(&pool, org, sender, channel, None).await;
    assert_eq!(
        nil_rows(&pool, org, channel).await,
        vec![(old[0].0, 4), (old[1].0, 3)]
    );
    assert_recount_clean(&pool, org).await;
}

#[fukulow_test::test(migrations = false)]
async fn scope_total_migration_retains_orphans_and_rollback_restores_totals(pool: PgPool) {
    migrate_before_f2(&pool).await;
    let (app, org, sender, live, _) = fixture(&pool).await;
    let reader = Uuid::new_v4();
    let viewer = member(&pool, org, reader).await;
    let orphan = Uuid::new_v4();
    super::super::channel(&pool, org, orphan, sender, false).await;
    for name in [None, Some("Live")] {
        historical_post(&pool, org, sender, live, name).await;
    }
    for name in [
        None,
        None,
        Some("Removed"),
        Some("Removed"),
        Some("Removed"),
    ] {
        historical_post(&pool, org, sender, orphan, name).await;
    }
    let live_totals = nil_rows(&pool, org, live).await;
    let orphan_totals = nil_rows(&pool, org, orphan).await;
    let live_topic = live_totals[1].0;
    let orphan_topic = orphan_totals[1].0;
    let nil = Uuid::nil();
    assert_eq!(live_totals, [(nil, 1), (live_topic, 1)]);
    assert_eq!(orphan_totals, [(nil, 2), (orphan_topic, 3)]);

    // Pre-F2 keeps the correction when an already-counted tombstone is removed.
    // A live Message without a sequence row would fail the above-counter check.
    for sql in [
        "UPDATE messages SET deleted=true WHERE organization_id=$1 AND channel_id=$2",
        "DELETE FROM messages WHERE organization_id=$1 AND channel_id=$2",
        "DELETE FROM topics WHERE organization_id=$1 AND channel_id=$2",
        "DELETE FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2",
    ] {
        assert!(
            sqlx::query(sql)
                .bind(org)
                .bind(orphan)
                .execute(&pool)
                .await
                .unwrap()
                .rows_affected()
                > 0
        );
    }
    assert_recount_clean(&pool, org).await;
    sqlx::migrate!().run(&pool).await.unwrap();
    assert_eq!(nil_rows(&pool, org, orphan).await, orphan_totals);
    assert!(nil_rows(&pool, org, live).await.is_empty());
    assert_recount_clean(&pool, org).await;

    let lists = channels(&app, &viewer).await;
    for channel in lists["channels"].as_array().unwrap() {
        let is_live = channel["id"] == live.to_string();
        assert_eq!(channel["main_unread_count"], i64::from(is_live));
        assert_eq!(channel["unread_count"], 2 * i64::from(is_live));
    }
    assert_eq!(lists["channels"].as_array().unwrap().len(), 2);
    assert_eq!(
        topics(&app, &viewer, live).await["topics"][0]["unread_count"],
        1
    );

    rollback_f2(&pool).await;
    assert_eq!(nil_rows(&pool, org, live).await, live_totals);
    assert_eq!(nil_rows(&pool, org, orphan).await, orphan_totals);
    assert_recount_clean(&pool, org).await;
    // Use the restored SQL reader because the F2 HTTP queries require F2 columns.
    for (channel, scope, watermark, expected) in [
        (live, nil, 2_i64, 1),
        (live, live_topic, 2, 1),
        (orphan, nil, 0, 0),
        (orphan, orphan_topic, 0, 0),
    ] {
        let ordinals: (i64, i64) =
            sqlx::query_as("SELECT * FROM message_count_ordinals($1,$2,$3,$4,$5)")
                .bind(org)
                .bind(channel)
                .bind(scope)
                .bind(reader)
                .bind(watermark)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(ordinals, (expected, 0));
    }
}
