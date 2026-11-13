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
               '_sqlx_migrations', -- SQLx bookkeeping shared by all organizations.
               'accounts', -- Global authentication identities.
               'account_sessions' -- Global credentials for one Account.
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
         WHERE i.indrelid = 'public.account_sessions'::regclass ORDER BY c.relname",
    )
    .fetch_all(pool)
    .await
}

#[sqlx::test(migrations = false)]
async fn session_indexes_keep_primary_key_and_global_expiry(pool: PgPool) {
    migrate(&pool).await.unwrap();
    assert_eq!(
        session_indexes(&pool).await.unwrap(),
        vec![
            Index {
                name: "account_sessions_account_id".into(),
                key_columns: vec!["account_id".into()],
                total_attributes: 1,
                options: vec![0],
                nulls_not_distinct: false,
                is_unique: false,
                is_primary: false,
                has_predicate: false,
                has_expressions: false,
                is_valid: true,
                method: "btree".into(),
            },
            Index {
                name: "account_sessions_expiry".into(),
                key_columns: vec!["expires_at".into(), "token_hash".into()],
                total_attributes: 2,
                options: vec![0, 0],
                nulls_not_distinct: false,
                is_unique: false,
                is_primary: false,
                has_predicate: false,
                has_expressions: false,
                is_valid: true,
                method: "btree".into(),
            },
            Index {
                name: "account_sessions_pkey".into(),
                key_columns: vec!["token_hash".into()],
                total_attributes: 1,
                options: vec![0],
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
    let member_index: String = sqlx::query_scalar("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='users' AND indexname='users_account_id'")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(
        member_index,
        "CREATE INDEX users_account_id ON public.users USING btree (account_id)"
    );
    let primary_key: (String, String) = sqlx::query_as(
        "SELECT c.conname::text, i.relname::text FROM pg_constraint c \
         JOIN pg_class i ON i.oid = c.conindid \
         WHERE c.conrelid = 'public.account_sessions'::regclass AND c.contype = 'p'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        primary_key,
        (
            "account_sessions_pkey".into(),
            "account_sessions_pkey".into()
        )
    );
}

#[sqlx::test(migrations = false)]
async fn session_index_check_distinguishes_include_sort_and_null_changes(pool: PgPool) {
    migrate(&pool).await.unwrap();
    let original = session_indexes(&pool).await.unwrap();
    for definition in [
        "(expires_at, token_hash) INCLUDE (account_id)",
        "(expires_at DESC, token_hash)",
        "(expires_at NULLS FIRST, token_hash)",
        "(expires_at, token_hash) NULLS NOT DISTINCT",
    ] {
        sqlx::raw_sql(&format!(
            "DROP INDEX account_sessions_expiry; \
             CREATE INDEX account_sessions_expiry ON account_sessions {definition}"
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
        "DROP INDEX account_sessions_expiry; \
         CREATE INDEX account_sessions_expiry \
         ON account_sessions (expires_at, token_hash)",
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
         CREATE TABLE other.accounts (id uuid PRIMARY KEY);
         CREATE TABLE other.account_sessions (id uuid PRIMARY KEY);
         CREATE TABLE other.valid (organization_id uuid NOT NULL);",
    )
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(
        check_organization_ids(&pool).await.unwrap_err(),
        "tables missing NOT NULL organization_id: [(\"other\", \"_sqlx_migrations\"), (\"other\", \"account_sessions\"), (\"other\", \"accounts\"), (\"other\", \"organizations\"), (\"public\", \"missing_organization\"), (\"public\", \"nullable_organization\")]"
    );

    sqlx::raw_sql(
        "ALTER TABLE missing_organization ADD COLUMN organization_id uuid NOT NULL;
         ALTER TABLE nullable_organization ALTER COLUMN organization_id SET NOT NULL;
         ALTER TABLE other.accounts ADD COLUMN organization_id uuid NOT NULL;
         ALTER TABLE other.account_sessions ADD COLUMN organization_id uuid NOT NULL;
         ALTER TABLE other.organizations ADD COLUMN organization_id uuid NOT NULL;
         ALTER TABLE other._sqlx_migrations ADD COLUMN organization_id uuid NOT NULL;",
    )
    .execute(&pool)
    .await
    .unwrap();
    check_organization_ids(&pool).await.unwrap();
}

/// #314: every table except the global exemptions is tenant-isolated by RLS,
/// with exactly the reviewed policies (no broad or extra permissive policy).
async fn check_row_level_security(pool: &PgPool) -> Result<(), String> {
    let violations: Vec<(String, String, String)> = sqlx::query_as(
        "WITH guarded AS (
             SELECT c.oid, n.nspname::text AS schema, c.relname::text AS name, c.relrowsecurity
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r', 'p')
               AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
               AND NOT (n.nspname = 'public' AND c.relname IN (
                   '_sqlx_migrations', -- SQLx bookkeeping; the app role may only SELECT it.
                   'accounts', -- Global authentication identities.
                   'account_sessions' -- Global credentials for one Account.
               ))
         ), policies AS (
             SELECT schemaname::text AS schema, tablename::text AS name, policyname::text AS policy,
                    cmd, permissive, roles, qual, with_check
             FROM pg_policies
         )
         SELECT schema, name, 'row level security disabled' FROM guarded WHERE NOT relrowsecurity
         UNION ALL
         SELECT g.schema, g.name, 'missing org_isolation' FROM guarded g
         WHERE NOT EXISTS (
             SELECT 1 FROM policies p
             WHERE p.schema = g.schema AND p.name = g.name AND p.policy = 'org_isolation'
               AND p.cmd = 'ALL' AND p.permissive = 'PERMISSIVE' AND p.roles = '{public}'
               AND p.qual = '(organization_id = fukulow_current_org())'
               AND p.with_check = '(organization_id = fukulow_current_org())')
         UNION ALL
         SELECT p.schema, p.name, 'unexpected policy ' || p.policy FROM policies p
         WHERE p.policy <> 'org_isolation'
           AND NOT (p.schema = 'public' AND p.policy = 'account_read' AND p.cmd = 'SELECT'
                    AND p.with_check IS NULL AND p.roles = '{public}' AND p.permissive = 'PERMISSIVE'
                    AND (p.name, regexp_replace(p.qual, '\\s+', ' ', 'g')) IN (
                        ('users', '(account_id = fukulow_current_account())'),
                        ('organizations', '(EXISTS ( SELECT 1 FROM users u WHERE ((u.organization_id = organizations.organization_id) AND (u.account_id = fukulow_current_account()))))')))
         ORDER BY 1, 2, 3",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("inspect row level security: {e}"))?;
    if violations.is_empty() {
        Ok(())
    } else {
        Err(format!("row level security violations: {violations:?}"))
    }
}

#[sqlx::test(migrations = false)]
async fn migrated_tables_have_tenant_row_level_security(pool: PgPool) {
    migrate(&pool).await.unwrap();
    check_row_level_security(&pool).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn schema_guard_rejects_tables_without_reviewed_row_level_security(pool: PgPool) {
    migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE no_rls (organization_id uuid NOT NULL);
         CREATE TABLE no_policy (organization_id uuid NOT NULL);
         ALTER TABLE no_policy ENABLE ROW LEVEL SECURITY;
         CREATE TABLE read_only_policy (organization_id uuid NOT NULL);
         ALTER TABLE read_only_policy ENABLE ROW LEVEL SECURITY;
         CREATE POLICY org_isolation ON read_only_policy FOR SELECT
             USING (organization_id = fukulow_current_org());
         CREATE POLICY broad ON channels FOR SELECT USING (true);
         CREATE POLICY account_read ON messages FOR SELECT USING (true);
         DROP POLICY account_read ON users;
         CREATE POLICY account_read ON users FOR SELECT USING (account_id IS NOT NULL);
         CREATE SCHEMA other;
         CREATE TABLE other.accounts (organization_id uuid NOT NULL);
         ALTER TABLE invites DISABLE ROW LEVEL SECURITY;",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        check_row_level_security(&pool).await.unwrap_err(),
        "row level security violations: [\
         (\"other\", \"accounts\", \"missing org_isolation\"), \
         (\"other\", \"accounts\", \"row level security disabled\"), \
         (\"public\", \"channels\", \"unexpected policy broad\"), \
         (\"public\", \"invites\", \"row level security disabled\"), \
         (\"public\", \"messages\", \"unexpected policy account_read\"), \
         (\"public\", \"no_policy\", \"missing org_isolation\"), \
         (\"public\", \"no_rls\", \"missing org_isolation\"), \
         (\"public\", \"no_rls\", \"row level security disabled\"), \
         (\"public\", \"read_only_policy\", \"missing org_isolation\"), \
         (\"public\", \"users\", \"unexpected policy account_read\")]"
    );
    sqlx::raw_sql(
        "DROP SCHEMA other CASCADE; DROP TABLE no_rls, no_policy, read_only_policy;
         DROP POLICY broad ON channels; DROP POLICY account_read ON messages;
         DROP POLICY account_read ON users;
         CREATE POLICY account_read ON users FOR SELECT USING (account_id = fukulow_current_account());
         ALTER TABLE invites ENABLE ROW LEVEL SECURITY;",
    )
    .execute(&pool)
    .await
    .unwrap();
    check_row_level_security(&pool).await.unwrap();
}
