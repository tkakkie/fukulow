#[fukulow_test::test(migrations = false)]
#[ignore = "manual #385-first check using the application's pinned sqlx, staged by load/invite-scan.ts"]
async fn measure_invite_migration_order(pool: sqlx::PgPool) {
    let directory = std::env::var("INVITE_COMBINED_MIGRATIONS").unwrap();
    let directory = std::path::Path::new(&directory);
    let combined = sqlx::migrate::Migrator::new(directory).await.unwrap();
    let mut first = sqlx::migrate::Migrator::new(directory).await.unwrap();
    first
        .migrations
        .to_mut()
        .retain(|migration| migration.version != 202611140303 && migration.version != 202611140388);
    assert_eq!(first.iter().last().unwrap().version, 202611140387);
    assert_eq!(combined.iter().count(), 24);
    first.run(&pool).await.unwrap();
    let max: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(max, 202611140387);
    combined.run(&pool).await.unwrap();
    combined.run(&pool).await.unwrap();
    // Same sorted version/checksum/success comparison as startup validation,
    // with the combined source set instead of this branch's embedded set.
    let applied: Vec<(i64, Vec<u8>, bool)> =
        sqlx::query_as("SELECT version,checksum,success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(applied.len(), combined.iter().count());
    for ((version, checksum, success), expected) in applied.iter().zip(combined.iter()) {
        assert!(*success);
        assert_eq!(*version, expected.version);
        assert_eq!(checksum.as_slice(), expected.checksum.as_ref());
    }
    println!(
        "INVITE_MIGRATION_ORDER pinned application sqlx: #385 first, then 0303/0388, repeat no-op; all 24 sorted versions/checksums/success match"
    );
}
