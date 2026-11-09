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
    #[derive(Debug, PartialEq, sqlx::FromRow)]
    struct Index {
        name: String,
        key_columns: Vec<String>,
        is_unique: bool,
        is_primary: bool,
        has_predicate: bool,
        has_expressions: bool,
        is_valid: bool,
        method: String,
    }

    migrate(&pool).await.unwrap();
    let indexes: Vec<Index> = sqlx::query_as(
        "SELECT c.relname::text AS name, \
                ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n) \
                      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum \
                      WHERE k.n <= i.indnkeyatts ORDER BY k.n) AS key_columns, \
                i.indisunique AS is_unique, i.indisprimary AS is_primary, \
                i.indpred IS NOT NULL AS has_predicate, i.indexprs IS NOT NULL AS has_expressions, \
                i.indisvalid AS is_valid, am.amname::text AS method \
         FROM pg_index i \
         JOIN pg_class c ON c.oid = i.indexrelid \
         JOIN pg_am am ON am.oid = c.relam \
         WHERE i.indrelid = 'public.sessions'::regclass ORDER BY c.relname",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        indexes,
        vec![
            Index {
                name: "sessions_organization_expiry".into(),
                key_columns: vec![
                    "organization_id".into(),
                    "expires_at".into(),
                    "token_hash".into()
                ],
                is_unique: false,
                is_primary: false,
                has_predicate: false,
                has_expressions: false,
                is_valid: true,
                method: "btree".into(),
            },
            Index {
                name: "sessions_pkey".into(),
                key_columns: vec!["organization_id".into(), "token_hash".into()],
                is_unique: true,
                is_primary: true,
                has_predicate: false,
                has_expressions: false,
                is_valid: true,
                method: "btree".into(),
            },
        ]
    );
    let primary_key: (String, String) = sqlx::query_as(
        "SELECT c.conname::text, i.relname::text FROM pg_constraint c \
         JOIN pg_class i ON i.oid = c.conindid \
         WHERE c.conrelid = 'public.sessions'::regclass AND c.contype = 'p'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        primary_key,
        ("sessions_pkey".into(), "sessions_pkey".into())
    );
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
