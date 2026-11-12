use crate::{database, test_support::TestPools};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
enum Variant {
    Organization,
    OrganizationReadOnly,
    Account,
    AccountReadOnly,
}

const VARIANTS: [Variant; 4] = [
    Variant::Organization,
    Variant::OrganizationReadOnly,
    Variant::Account,
    Variant::AccountReadOnly,
];

impl Variant {
    fn organization(self) -> bool {
        matches!(self, Self::Organization | Self::OrganizationReadOnly)
    }

    fn read_only(self) -> bool {
        matches!(self, Self::OrganizationReadOnly | Self::AccountReadOnly)
    }

    async fn run<T>(
        self,
        pool: &PgPool,
        id: Uuid,
        body: impl AsyncFnOnce(&mut PgConnection) -> Result<T, sqlx::Error>,
    ) -> Result<T, sqlx::Error> {
        match self {
            Self::Organization => database::organization(pool, id, body).await,
            Self::OrganizationReadOnly => database::organization_read_only(pool, id, body).await,
            Self::Account => database::account(pool, id, body).await,
            Self::AccountReadOnly => database::account_read_only(pool, id, body).await,
        }
    }
}

pub(crate) async fn pools(pool: PgPool) -> TestPools {
    TestPools::new(super::startup_pool(&pool).await).await
}

pub(crate) async fn settings(tx: &mut PgConnection) -> (Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT NULLIF(current_setting('fukulow.organization_id', true), ''), \
        NULLIF(current_setting('fukulow.account_id', true), '')",
    )
    .fetch_one(tx)
    .await
    .unwrap()
}

pub(crate) async fn clean(pool: &PgPool) -> i32 {
    let mut tx = pool.begin().await.unwrap();
    assert_eq!(settings(&mut tx).await, (None, None));
    let (pid, read_only): (i32, String) =
        sqlx::query_as("SELECT pg_backend_pid(), current_setting('transaction_read_only')")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert_eq!(read_only, "off");
    tx.rollback().await.unwrap();
    pid
}

async fn inside(tx: &mut PgConnection, id: Uuid, organization: bool) {
    let expected = if organization {
        (Some(id.to_string()), None)
    } else {
        (None, Some(id.to_string()))
    };
    assert_eq!(settings(tx).await, expected);
}

#[sqlx::test]
async fn context_helpers_scope_settings_and_preserve_transaction_modes(pool: PgPool) {
    let pools = pools(pool).await;
    sqlx::query("CREATE TABLE context_probe (organization_id uuid NOT NULL)")
        .execute(&pools.admin)
        .await
        .unwrap();
    let pid = clean(&pools.app).await;
    for variant in VARIANTS {
        // Successful work, ordinary body error, propagated SQL error, swallowed SQL error.
        for outcome in 0..4 {
            let id = Uuid::new_v4();
            let result = variant.run(&pools.app, id, async |tx: &mut PgConnection| {
                inside(tx, id, variant.organization()).await;
                let mode: (String, String) = sqlx::query_as(
                    "SELECT current_setting('transaction_read_only'), current_setting('transaction_isolation')",
                ).fetch_one(&mut *tx).await?;
                assert_eq!(mode, if variant.read_only() { ("on".into(), "repeatable read".into()) }
                    else { ("off".into(), "read committed".into()) });
                if !variant.read_only() {
                    sqlx::query("INSERT INTO context_probe (organization_id) VALUES ($1)")
                        .bind(id).execute(&mut *tx).await?;
                }
                match outcome {
                    1 => Err(sqlx::Error::RowNotFound),
                    2 | 3 => {
                        let error = sqlx::query("SELECT 1 / 0").execute(&mut *tx).await.unwrap_err();
                        if outcome == 2 { Err(error) } else { Ok(()) }
                    }
                    _ => Ok(()),
                }
            }).await;
            if outcome == 1 {
                assert!(matches!(result, Err(sqlx::Error::RowNotFound)));
            } else {
                assert_eq!(result.is_err(), outcome == 2, "{variant:?}: {result:?}");
            }
            assert_eq!(
                clean(&pools.app).await,
                pid,
                "completed work must reuse its backend"
            );
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM context_probe WHERE organization_id = $1")
                    .bind(id)
                    .fetch_one(&pools.admin)
                    .await
                    .unwrap();
            assert_eq!(count, i64::from(!variant.read_only() && outcome == 0));
        }
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn context_helpers_cancelled_begin_setting_work_and_cleanup_discard(pool: PgPool) {
    let pools = pools(pool).await;
    for variant in VARIANTS {
        let begin = if variant.read_only() {
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
        } else {
            "BEGIN"
        };
        let setting = if variant.organization() {
            "SELECT set_config('fukulow.organization_id', $1, true)"
        } else {
            "SELECT set_config('fukulow.account_id', $1, true)"
        };
        let end = if variant.read_only() {
            "ROLLBACK"
        } else {
            "COMMIT"
        };
        for statement in [begin, setting, "SELECT 314314", end] {
            super::interrupted::at(
                &pools.admin,
                &pools.app,
                statement,
                async |single: &PgPool| {
                    variant
                        .run(single, Uuid::new_v4(), async |tx: &mut PgConnection| {
                            sqlx::query("SELECT 314314").execute(tx).await?;
                            Ok(())
                        })
                        .await
                },
            )
            .await;
        }
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn context_helpers_failed_rollback_preserves_body_error_and_discards(pool: PgPool) {
    let pools = pools(pool).await;
    for variant in VARIANTS {
        super::interrupted::failed_rollback(&pools.app, async |single: &PgPool, pid| {
            let id = Uuid::new_v4();
            let result = variant
                .run(single, id, async |tx: &mut PgConnection| {
                    inside(tx, id, variant.organization()).await;
                    Err::<(), _>(sqlx::Error::RowNotFound)
                })
                .await;
            assert!(
                matches!(result, Err(sqlx::Error::RowNotFound)),
                "{result:?}"
            );
            assert_ne!(
                clean(single).await,
                pid,
                "failed ROLLBACK must discard a live backend"
            );
        })
        .await;
    }
    pools.app.close().await;
}

// TEMP objects stay on the admin connection; the restricted app role has no DDL.
async fn deferred_violation(tx: &mut PgConnection) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(
        "CREATE TEMP TABLE context_deferred (
            organization_id uuid NOT NULL,
            value integer UNIQUE DEFERRABLE INITIALLY DEFERRED
         );
         INSERT INTO context_deferred VALUES (gen_random_uuid(), 1), (gen_random_uuid(), 1);",
    )
    .execute(tx)
    .await?;
    Ok(())
}

#[sqlx::test]
async fn context_helpers_failed_commit_discards_live_connection(pool: PgPool) {
    let pools = pools(pool).await;
    assert_eq!(pools.admin.options().get_max_connections(), 1);
    for variant in [Variant::Organization, Variant::Account] {
        // Control: a deferred COMMIT error leaves a live, reusable SQLx connection.
        let mut connection = pools.admin.acquire().await.unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection)
            .await
            .unwrap();
        sqlx::Executor::execute(&mut *connection, "BEGIN")
            .await
            .unwrap();
        deferred_violation(&mut connection).await.unwrap();
        let error = sqlx::Executor::execute(&mut *connection, "COMMIT")
            .await
            .unwrap_err();
        assert_eq!(
            error.as_database_error().unwrap().code().as_deref(),
            Some("23505")
        );
        connection.return_to_pool().await;
        drop(connection);
        assert_eq!(
            clean(&pools.admin).await,
            pid,
            "SQLx must reuse a backend after a deferred COMMIT error"
        );

        let result = variant
            .run(
                &pools.admin,
                Uuid::new_v4(),
                async |tx: &mut PgConnection| deferred_violation(tx).await,
            )
            .await;
        assert_eq!(
            result
                .unwrap_err()
                .as_database_error()
                .unwrap()
                .code()
                .as_deref(),
            Some("23505")
        );
        assert_ne!(
            clean(&pools.admin).await,
            pid,
            "failed COMMIT must discard a live backend"
        );
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn context_values_are_bound_before_work(pool: PgPool) {
    let pools = pools(pool).await;
    let pid = clean(&pools.app).await;
    for variant in VARIANTS {
        let id = Uuid::new_v4();
        variant
            .run(&pools.app, id, async |tx: &mut PgConnection| {
                // Inspect the last statement from a different backend before work issues SQL.
                let query: String =
                    sqlx::query_scalar("SELECT query FROM pg_stat_activity WHERE pid = $1")
                        .bind(pid)
                        .fetch_one(&pools.admin)
                        .await?;
                let key = if variant.organization() {
                    "organization_id"
                } else {
                    "account_id"
                };
                assert_eq!(
                    query,
                    format!("SELECT set_config('fukulow.{key}', $1, true)")
                );
                inside(tx, id, variant.organization()).await;
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(clean(&pools.app).await, pid);
    }
    pools.app.close().await;
}
