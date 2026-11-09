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

#[derive(Debug, PartialEq, sqlx::FromRow)]
struct Index {
    name: String,
    key_columns: Vec<String>,
    total_attributes: i16,
    options: Vec<i16>,
    nulls_not_distinct: bool,
    is_unique: bool,
    is_primary: bool,
    has_predicate: bool,
    has_expressions: bool,
    is_valid: bool,
    method: String,
}

async fn session_indexes(pool: &PgPool) -> Result<Vec<Index>, sqlx::Error> {
    // Rebuild indoption as a one-based array; SQLx cannot decode the catalog's
    // zero-based int2vector directly, even when cast to int2[].
    sqlx::query_as(
        "SELECT c.relname::text AS name, \
                ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n) \
                      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum \
                      WHERE k.n <= i.indnkeyatts ORDER BY k.n) AS key_columns, \
                i.indnatts AS total_attributes, \
                ARRAY(SELECT unnest(i.indoption::int2[])) AS options, \
                i.indnullsnotdistinct AS nulls_not_distinct, \
                i.indisunique AS is_unique, i.indisprimary AS is_primary, \
                i.indpred IS NOT NULL AS has_predicate, i.indexprs IS NOT NULL AS has_expressions, \
                i.indisvalid AS is_valid, am.amname::text AS method \
         FROM pg_index i \
         JOIN pg_class c ON c.oid = i.indexrelid \
         JOIN pg_am am ON am.oid = c.relam \
         WHERE i.indrelid = 'public.sessions'::regclass ORDER BY c.relname",
    )
    .fetch_all(pool)
    .await
}

#[sqlx::test(migrations = false)]
async fn session_indexes_keep_primary_key_and_scoped_expiry_without_global_expiry(pool: PgPool) {
    migrate(&pool).await.unwrap();
    assert_eq!(
        session_indexes(&pool).await.unwrap(),
        vec![
            Index {
                name: "sessions_organization_expiry".into(),
                key_columns: vec![
                    "organization_id".into(),
                    "expires_at".into(),
                    "token_hash".into()
                ],
                total_attributes: 3,
                options: vec![0, 0, 0],
                nulls_not_distinct: false,
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
                total_attributes: 2,
                options: vec![0, 0],
                nulls_not_distinct: false,
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
async fn session_index_check_distinguishes_include_sort_and_null_changes(pool: PgPool) {
    migrate(&pool).await.unwrap();
    let original = session_indexes(&pool).await.unwrap();
    for definition in [
        "(organization_id, expires_at, token_hash) INCLUDE (user_id)",
        "(organization_id DESC, expires_at, token_hash)",
        "(organization_id NULLS FIRST, expires_at, token_hash)",
        "(organization_id, expires_at, token_hash) NULLS NOT DISTINCT",
    ] {
        sqlx::raw_sql(&format!(
            "DROP INDEX sessions_organization_expiry; \
             CREATE INDEX sessions_organization_expiry ON sessions {definition}"
        ))
        .execute(&pool)
        .await
        .unwrap();
        assert_ne!(
            session_indexes(&pool).await.unwrap(),
            original,
            "structural check must detect {definition}"
        );
    }
    sqlx::raw_sql(
        "DROP INDEX sessions_organization_expiry; \
         CREATE INDEX sessions_organization_expiry \
         ON sessions (organization_id, expires_at, token_hash)",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(session_indexes(&pool).await.unwrap(), original);
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
