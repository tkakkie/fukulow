//! Keep the runtime RLS test table list in sync with the migrated schema.
use super::TABLES;
use sqlx::PgPool;
use std::collections::BTreeSet;

async fn check_coverage(pool: &PgPool) -> Result<(), String> {
    let enabled: BTreeSet<(String, String)> = sqlx::query_as(
        "SELECT n.nspname::text, c.relname::text
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p') AND c.relrowsecurity
           AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("inspect migrated RLS tables: {error}"))?
    .into_iter()
    .collect();
    let listed: BTreeSet<_> = TABLES
        .iter()
        .map(|&table| ("public".to_owned(), table.to_owned()))
        .collect();
    let missing: Vec<_> = enabled.difference(&listed).collect();
    let stale: Vec<_> = listed.difference(&enabled).collect();
    if missing.is_empty() && stale.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "unlisted RLS tables: {missing:?}; listed tables without RLS: {stale:?}"
        ))
    }
}

#[fukulow_test::test]
async fn rls_list_matches_migrations(pool: PgPool) {
    check_coverage(&pool).await.unwrap();
}

#[fukulow_test::test]
async fn rls_coverage_rejects_an_unlisted_table(pool: PgPool) {
    check_coverage(&pool).await.unwrap();
    sqlx::raw_sql(
        "CREATE SCHEMA coverage_probe;
         CREATE TABLE coverage_probe.dm_discovery (organization_id uuid NOT NULL);
         ALTER TABLE coverage_probe.dm_discovery ENABLE ROW LEVEL SECURITY;",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        check_coverage(&pool).await.unwrap_err(),
        "unlisted RLS tables: [(\"coverage_probe\", \"dm_discovery\")]; listed tables without RLS: []"
    );
}
