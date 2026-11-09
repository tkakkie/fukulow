use sqlx::PgPool;

async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    // Discover files at runtime: adding a migration must not depend on Cargo
    // invalidating SQLx's compile-time migration list in a cached test binary.
    sqlx::migrate::Migrator::new(std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations"
    )))
    .await?
    .run(pool)
    .await
}

async fn check_organization_ids(pool: &PgPool) -> Result<(), String> {
    let violations: Vec<(String, String)> = sqlx::query_as(
        "SELECT t.table_schema, t.table_name
         FROM information_schema.tables t
         WHERE t.table_type = 'BASE TABLE'
           AND t.table_schema <> 'information_schema'
           AND t.table_schema !~ '^pg_'
           AND NOT (t.table_schema = 'public' AND t.table_name IN (
               'organizations', -- Tenant root, not owned by another organization.
               '_sqlx_migrations' -- SQLx bookkeeping shared by all organizations.
           ))
           AND NOT EXISTS (
               SELECT 1 FROM information_schema.columns c
               WHERE c.table_schema = t.table_schema
                 AND c.table_name = t.table_name
                 AND c.column_name = 'organization_id'
                 AND c.is_nullable = 'NO'
           )
         ORDER BY t.table_schema, t.table_name",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("inspect all migrated tables: {e}"))?;

    if violations.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "tables missing NOT NULL organization_id: {violations:?}"
        ))
    }
}

#[sqlx::test(migrations = false)]
async fn migrated_tables_have_not_null_organization_id(pool: PgPool) {
    migrate(&pool).await.unwrap();
    check_organization_ids(&pool).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn session_indexes_keep_primary_key_and_scoped_expiry_without_global_expiry(pool: PgPool) {
    migrate(&pool).await.unwrap();
    let indexes: Vec<(String, String)> = sqlx::query_as(
        "SELECT indexname, indexdef FROM pg_indexes \
         WHERE schemaname = 'public' AND tablename = 'sessions' ORDER BY indexname",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        indexes,
        vec![
            (
                "sessions_organization_expiry".into(),
                "CREATE INDEX sessions_organization_expiry ON public.sessions USING btree (organization_id, expires_at, token_hash)".into(),
            ),
            (
                "sessions_pkey".into(),
                "CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (organization_id, token_hash)".into(),
            ),
        ]
    );
    let primary_key: String = sqlx::query_scalar(
        "SELECT conname FROM pg_constraint \
         WHERE conrelid = 'public.sessions'::regclass AND contype = 'p'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(primary_key, "sessions_pkey");
}

#[sqlx::test(migrations = false)]
async fn schema_guard_rejects_missing_and_nullable_organization_id(pool: PgPool) {
    migrate(&pool).await.unwrap();
    check_organization_ids(&pool).await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE missing_organization (id uuid PRIMARY KEY);
         CREATE TABLE nullable_organization (organization_id uuid);
         CREATE SCHEMA other;
         CREATE TABLE other.organizations (id uuid PRIMARY KEY);
         CREATE TABLE other._sqlx_migrations (id bigint PRIMARY KEY);
         CREATE TABLE other.valid (organization_id uuid NOT NULL);",
    )
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(
        check_organization_ids(&pool).await.unwrap_err(),
        "tables missing NOT NULL organization_id: [(\"other\", \"_sqlx_migrations\"), (\"other\", \"organizations\"), (\"public\", \"missing_organization\"), (\"public\", \"nullable_organization\")]"
    );

    sqlx::raw_sql(
        "ALTER TABLE missing_organization ADD COLUMN organization_id uuid NOT NULL;
         ALTER TABLE nullable_organization ALTER COLUMN organization_id SET NOT NULL;
         ALTER TABLE other.organizations ADD COLUMN organization_id uuid NOT NULL;
         ALTER TABLE other._sqlx_migrations ADD COLUMN organization_id uuid NOT NULL;",
    )
    .execute(&pool)
    .await
    .unwrap();
    check_organization_ids(&pool).await.unwrap();
}
