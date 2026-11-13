//! #314 step 4: production RLS policies, exercised as the restricted test role.
use super::context::pools;
use crate::database;
use sqlx::{PgConnection, PgPool, postgres::PgPoolOptions};
use uuid::Uuid;

const TABLES: [&str; 10] = [
    "organizations",
    "users",
    "channels",
    "channel_members",
    "channel_message_sequences",
    "messages",
    "topics",
    "channel_read_positions",
    "topic_read_positions",
    "invites",
];

struct Tenant {
    organization: Uuid,
    account: Uuid,
}

/// One row (or more) in every target table, written as the owner.
async fn tenant(admin: &PgPool) -> Tenant {
    let (organization, account, member, channel, topic) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    sqlx::query(
        "WITH o AS (INSERT INTO organizations (organization_id, name) VALUES ($1, 'Organization')),
         a AS (INSERT INTO accounts (id, email, password_hash) VALUES ($2, $2::text || '@example.com', 'unused'))
         SELECT 1",
    )
    .bind(organization)
    .bind(account)
    .execute(admin)
    .await
    .unwrap();
    for sql in [
        "INSERT INTO users (organization_id, id, account_id, name, role) VALUES ($1, $3, $2, 'Member', 'owner')",
        "INSERT INTO channels (organization_id, id, name, visibility) VALUES ($1, $4, 'general', 'public')",
        "INSERT INTO channel_members (organization_id, channel_id, member_id) VALUES ($1, $4, $3)",
        "INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES ($1, $4, 0) ON CONFLICT DO NOTHING",
        "INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count) VALUES ($1, $4, $5, 'topic', 1, 1, 1)",
        "UPDATE channel_message_sequences SET seq = 1 WHERE organization_id = $1 AND channel_id = $4",
        "INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id) VALUES ($1, gen_random_uuid(), $4, 1, $3, gen_random_uuid(), 'hello', $5)",
        "INSERT INTO channel_read_positions (organization_id, channel_id, member_id, membership_revision, initial_seq, read_seq) SELECT $1, $4, $3, membership_revision, 0, 0 FROM users WHERE organization_id = $1 AND id = $3 ON CONFLICT DO NOTHING",
        "INSERT INTO topic_read_positions (organization_id, channel_id, member_id, topic_id, read_seq) VALUES ($1, $4, $3, $5, 0) ON CONFLICT DO NOTHING",
        "INSERT INTO invites (organization_id, id, created_by, email, role, token_hash, expires_at) VALUES ($1, gen_random_uuid(), $3, 'invitee@example.com', 'member', sha256(gen_random_uuid()::text::bytea), now() + interval '1 day')",
    ] {
        sqlx::query(sql)
            .bind(organization)
            .bind(account)
            .bind(member)
            .bind(channel)
            .bind(topic)
            .execute(admin)
            .await
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }
    Tenant {
        organization,
        account,
    }
}

async fn counts(connection: &mut PgConnection, organization: Uuid) -> Vec<(i64, i64)> {
    let mut counts = Vec::new();
    for table in TABLES {
        counts.push(
            sqlx::query_as(&format!(
                "SELECT count(*), count(*) FILTER (WHERE organization_id = $1) FROM {table}"
            ))
            .bind(organization)
            .fetch_one(&mut *connection)
            .await
            .unwrap(),
        );
    }
    counts
}

fn sqlstate(error: &sqlx::Error) -> Option<String> {
    error
        .as_database_error()
        .and_then(|error| error.code())
        .map(|code| code.into_owned())
}

/// Copy one visible row of `table` with `organization_id` replaced.
fn copy_sql(table: &str) -> String {
    format!(
        "INSERT INTO {table} SELECT (jsonb_populate_record(NULL::{table}, to_jsonb(t) || jsonb_build_object('organization_id', $1::uuid))).* FROM {table} t LIMIT 1"
    )
}

#[sqlx::test]
async fn rls_hides_and_rejects_other_organization_rows_in_every_target_table(pool: PgPool) {
    let pools = pools(pool).await;
    let (a, b) = (tenant(&pools.admin).await, tenant(&pools.admin).await);
    database::organization(&pools.app, a.organization, async |tx: &mut PgConnection| {
        for (table, (all, own)) in TABLES.iter().zip(counts(tx, a.organization).await) {
            assert!(own > 0, "{table}: own rows visible");
            assert_eq!(all, own, "{table}: only own Organization visible");
        }
        Ok::<_, sqlx::Error>(())
    })
    .await
    .unwrap();
    for table in TABLES {
        // Each case runs in its own transaction: an error aborts it.
        let insert =
            database::organization(&pools.app, a.organization, async |tx: &mut PgConnection| {
                sqlx::query(&copy_sql(table))
                    .bind(b.organization)
                    .execute(&mut *tx)
                    .await
            })
            .await
            .unwrap_err();
        assert_eq!(
            sqlstate(&insert).as_deref(),
            Some("42501"),
            "{table}: INSERT other: {insert}"
        );
        let moved =
            database::organization(&pools.app, a.organization, async |tx: &mut PgConnection| {
                sqlx::query(&format!("UPDATE {table} SET organization_id = $1"))
                    .bind(b.organization)
                    .execute(&mut *tx)
                    .await
            })
            .await
            .unwrap_err();
        // users' identity trigger rejects organization_id changes before RLS.
        let expected = if table == "users" { "P0001" } else { "42501" };
        assert_eq!(
            sqlstate(&moved).as_deref(),
            Some(expected),
            "{table}: UPDATE move: {moved}"
        );
        database::organization(&pools.app, a.organization, async |tx: &mut PgConnection| {
            for sql in [
                format!("UPDATE {table} SET organization_id = organization_id WHERE organization_id = $1"),
                format!("DELETE FROM {table} WHERE organization_id = $1"),
            ] {
                let affected = sqlx::query(&sql).bind(b.organization).execute(&mut *tx).await?;
                assert_eq!(affected.rows_affected(), 0, "{table}: {sql}");
            }
            Ok::<_, sqlx::Error>(())
        })
        .await
        .unwrap();
    }
    // The owner still sees B intact.
    let mut admin = pools.admin.acquire().await.unwrap();
    for (table, (_, own)) in TABLES.iter().zip(counts(&mut admin, b.organization).await) {
        assert!(own > 0, "{table}: B rows survive");
    }
    drop(admin);
    pools.app.close().await;
}

#[sqlx::test]
async fn rls_without_context_reads_nothing_and_writes_nothing(pool: PgPool) {
    let pools = pools(pool).await;
    let a = tenant(&pools.admin).await;
    let mut connection = pools.app.acquire().await.unwrap();
    for (table, (all, _)) in TABLES
        .iter()
        .zip(counts(&mut connection, a.organization).await)
    {
        assert_eq!(all, 0, "{table}: no context reads nothing");
        for sql in [
            format!("UPDATE {table} SET organization_id = organization_id"),
            format!("DELETE FROM {table}"),
        ] {
            let affected = sqlx::query(&sql).execute(&mut *connection).await.unwrap();
            assert_eq!(affected.rows_affected(), 0, "{table}: {sql}");
        }
    }
    drop(connection);
    // Copy as the owner-visible row: INSERT without context fails WITH CHECK.
    for table in TABLES {
        let row: serde_json::Value = sqlx::query_scalar(&format!(
            "SELECT to_jsonb(t) FROM {table} t WHERE organization_id = $1 LIMIT 1"
        ))
        .bind(a.organization)
        .fetch_one(&pools.admin)
        .await
        .unwrap();
        let error = sqlx::query(&format!(
            "INSERT INTO {table} SELECT (jsonb_populate_record(NULL::{table}, $1)).*"
        ))
        .bind(row)
        .execute(&pools.app)
        .await
        .unwrap_err();
        assert_eq!(
            sqlstate(&error).as_deref(),
            Some("42501"),
            "{table}: {error}"
        );
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn rls_account_context_reads_only_own_members_and_writes_nothing(pool: PgPool) {
    let pools = pools(pool).await;
    let (a, b) = (tenant(&pools.admin).await, tenant(&pools.admin).await);
    database::account(&pools.app, a.account, async |tx: &mut PgConnection| {
        for (table, (all, own)) in TABLES.iter().zip(counts(tx, a.organization).await) {
            let expected = if matches!(*table, "users" | "organizations") {
                1
            } else {
                0
            };
            assert_eq!((all, own), (expected, expected), "{table}: Account context");
        }
        for sql in [
            "UPDATE users SET name = name",
            "UPDATE organizations SET name = name",
            "DELETE FROM users",
            "DELETE FROM organizations",
        ] {
            assert_eq!(
                sqlx::query(sql).execute(&mut *tx).await?.rows_affected(),
                0,
                "{sql}"
            );
        }
        Ok::<_, sqlx::Error>(())
    })
    .await
    .unwrap();
    for table in ["users", "organizations"] {
        let error = database::account(&pools.app, a.account, async |tx: &mut PgConnection| {
            sqlx::query(&copy_sql(table))
                .bind(b.organization)
                .execute(&mut *tx)
                .await
        })
        .await
        .unwrap_err();
        assert_eq!(
            sqlstate(&error).as_deref(),
            Some("42501"),
            "{table}: {error}"
        );
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn rls_context_never_survives_commit_rollback_or_abort_on_a_reused_connection(pool: PgPool) {
    let pools = pools(pool).await;
    let a = tenant(&pools.admin).await;
    let single = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(pools.app.connect_options().as_ref().clone())
        .await
        .unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&single)
        .await
        .unwrap();
    let visible = async || -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM channels")
            .fetch_one(&single)
            .await
            .unwrap()
    };
    database::organization(&single, a.organization, async |tx: &mut PgConnection| {
        sqlx::query("SELECT 1").execute(&mut *tx).await
    })
    .await
    .unwrap();
    assert_eq!(visible().await, 0, "after COMMIT");
    database::organization_read_only(&single, a.organization, async |tx: &mut PgConnection| {
        sqlx::query("SELECT 1").execute(&mut *tx).await
    })
    .await
    .unwrap();
    assert_eq!(visible().await, 0, "after read-only ROLLBACK");
    let aborted = database::organization(&single, a.organization, async |tx: &mut PgConnection| {
        sqlx::query("SELECT 1 / 0").execute(&mut *tx).await
    })
    .await;
    assert!(aborted.is_err());
    assert_eq!(visible().await, 0, "after abort");
    let same: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&single)
        .await
        .unwrap();
    assert_eq!(same, pid, "the same pooled connection was reused");
    single.close().await;
    pools.app.close().await;
}

#[sqlx::test]
async fn setup_required_is_boolean_only_and_executable_only_by_the_app_role(pool: PgPool) {
    let pools = pools(pool).await;
    let required: bool = sqlx::query_scalar("SELECT fukulow_setup_required()")
        .fetch_one(&pools.app)
        .await
        .unwrap();
    assert!(required);
    tenant(&pools.admin).await;
    let required: bool = sqlx::query_scalar("SELECT fukulow_setup_required()")
        .fetch_one(&pools.app)
        .await
        .unwrap();
    assert!(!required, "the definer sees rows RLS hides from the caller");
    let (app, public, result): (bool, bool, String) = sqlx::query_as(
        "SELECT has_function_privilege('fukulow_sqlx_test_app', 'fukulow_setup_required()', 'EXECUTE'),
                EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                        WHERE p.proname = 'fukulow_setup_required' AND acl.grantee = 0),
                pg_get_function_result('fukulow_setup_required()'::regprocedure)",
    )
    .fetch_one(&pools.admin)
    .await
    .unwrap();
    assert_eq!((app, public, result.as_str()), (true, false, "boolean"));
    pools.app.close().await;
}
