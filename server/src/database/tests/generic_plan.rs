use super::context::{clean, pools};
use crate::database::{generic_plan, organization_statement_sql};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

async fn single(app: &PgPool) -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect_with(app.connect_options().as_ref().clone())
        .await
        .unwrap()
}

async fn plan_cache_mode(pool: &PgPool) -> String {
    sqlx::query_scalar("SELECT current_setting('plan_cache_mode')")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[fukulow_test::test]
async fn generic_statement_rolls_back_body_errors_to_a_clean_connection(pool: PgPool) {
    let pools = pools(pool).await;
    let single = single(&pools.app).await;
    let pid = clean(&single).await;
    let org = Uuid::new_v4();
    // Positive control: the body runs read-only under a generic plan with the context.
    let inside: (String, String, String, String) = generic_plan::organization_statement_generic(
        &single,
        "SELECT current_setting('plan_cache_mode'), current_setting('transaction_read_only'), \
                current_setting('fukulow.organization_id'), current_setting('transaction_isolation')",
        async |connection: &mut PgConnection, sql: &str| {
            sqlx::query_as(sql).bind(org).fetch_one(connection).await
        },
    )
    .await
    .unwrap();
    assert_eq!(
        inside,
        (
            "force_generic_plan".into(),
            "on".into(),
            org.to_string(),
            "read committed".into()
        )
    );
    assert_eq!(clean(&single).await, pid);
    assert_eq!(plan_cache_mode(&single).await, "auto");
    let result = generic_plan::organization_statement_generic(
        &single,
        "SELECT 1 / 0",
        async |connection: &mut PgConnection, sql: &str| {
            sqlx::query(sql).bind(org).fetch_all(connection).await
        },
    )
    .await;
    assert!(matches!(result, Err(sqlx::Error::Database(_))));
    // The confirmed ROLLBACK keeps the connection, with no setting or context left.
    assert_eq!(clean(&single).await, pid);
    assert_eq!(plan_cache_mode(&single).await, "auto");
    single.close().await;
    pools.app.close().await;
}

#[fukulow_test::test]
async fn generic_statement_interrupted_at_each_round_trip_discards(pool: PgPool) {
    let pools = pools(pool).await;
    let sql = organization_statement_sql("SELECT 515515");
    for statement in [generic_plan::BEGIN, sql.as_str(), "ROLLBACK"] {
        super::interrupted::at(
            &pools.admin,
            &pools.app,
            statement,
            async |single: &PgPool| {
                generic_plan::organization_statement_generic(
                    single,
                    "SELECT 515515",
                    async |connection: &mut PgConnection, sql: &str| {
                        sqlx::query(sql)
                            .bind(Uuid::new_v4())
                            .fetch_all(connection)
                            .await
                            .map(|_| ())
                    },
                )
                .await
            },
        )
        .await;
    }
    pools.app.close().await;
}

#[fukulow_test::test]
async fn generic_statement_cancelled_during_rls_read_discards(pool: PgPool) {
    let pools = pools(pool).await;
    let org = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO organizations (organization_id,name) VALUES ($1,'Cancellation control')",
    )
    .bind(org)
    .execute(&pools.admin)
    .await
    .unwrap();
    let single = single(&pools.app).await;
    let pid = clean(&single).await;
    let pending_pool = single.clone();
    let pending = tokio::spawn(async move {
        generic_plan::organization_statement_generic(
            &pending_pool,
            "SELECT organization_id, pg_sleep(60) FROM organizations",
            async |connection: &mut PgConnection, sql: &str| {
                sqlx::query(sql).bind(org).fetch_all(connection).await
            },
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let sleeping: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep')",
            )
            .bind(pid)
            .fetch_one(&pools.admin)
            .await
            .unwrap();
            if sleeping {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("RLS row was read before cancellation during pg_sleep");
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    let replacement = tokio::time::timeout(std::time::Duration::from_secs(5), clean(&single))
        .await
        .unwrap();
    assert_ne!(replacement, pid, "the open transaction is never reused");
    assert_eq!(plan_cache_mode(&single).await, "auto");
    let absent: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations")
        .fetch_one(&single)
        .await
        .unwrap();
    assert_eq!(absent, 0, "the replacement fails closed without context");
    single.close().await;
    pools.app.close().await;
}

// The divisor is zero only while the statement sees the installed context and
// the RLS-visible Organization row, so neither planning nor a missing context
// can raise it.
#[fukulow_test::test]
async fn generic_statement_context_dependent_error_rolls_back_to_a_clean_connection(pool: PgPool) {
    let pools = pools(pool).await;
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (organization_id,name) VALUES ($1,'Error control')")
        .bind(org)
        .execute(&pools.admin)
        .await
        .unwrap();
    let single = single(&pools.app).await;
    let pid = clean(&single).await;
    let sql = "SELECT 1 / CASE WHEN current_setting('fukulow.organization_id', true) = $1::uuid::text \
               THEN (SELECT count(*) FROM organizations) - 1 ELSE 1 END";
    let run = async |id: Uuid| {
        generic_plan::organization_statement_generic(
            &single,
            sql,
            async |connection: &mut PgConnection, sql: &str| {
                sqlx::query_scalar::<_, i64>(sql)
                    .bind(id)
                    .fetch_all(connection)
                    .await
            },
        )
        .await
    };
    // Positive control: another Organization's context sees no row.
    assert_eq!(run(Uuid::new_v4()).await.unwrap(), vec![-1]);
    assert_eq!(clean(&single).await, pid);
    let error = run(org).await.unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("22012"),
        "{error:?}"
    );
    assert_eq!(clean(&single).await, pid, "confirmed ROLLBACK keeps it");
    assert_eq!(plan_cache_mode(&single).await, "auto");
    let absent: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations")
        .fetch_one(&single)
        .await
        .unwrap();
    assert_eq!(absent, 0, "no Organization context is left behind");
    single.close().await;
    pools.app.close().await;
}

#[fukulow_test::test]
async fn generic_statement_failed_set_local_discards_before_the_body(pool: PgPool) {
    let pools = pools(pool).await;
    let failing = generic_plan::BEGIN.replace("force_generic_plan", "no_such_mode");
    super::interrupted::failed_start(
        &pools.app,
        generic_plan::BEGIN,
        &failing,
        async |single: &PgPool, pid| {
            let ran = std::cell::Cell::new(false);
            let error = generic_plan::organization_statement_generic(
                single,
                "SELECT 1",
                async |connection: &mut PgConnection, sql: &str| {
                    ran.set(true);
                    sqlx::query(sql)
                        .bind(Uuid::new_v4())
                        .fetch_all(connection)
                        .await
                },
            )
            .await
            .unwrap_err();
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("22023"),
                "{error:?}"
            );
            assert!(!ran.get(), "the body never runs without its setting");
            assert_ne!(
                clean(single).await,
                pid,
                "the failed transaction is discarded"
            );
            assert_eq!(plan_cache_mode(single).await, "auto");
        },
    )
    .await;
    pools.app.close().await;
}

#[fukulow_test::test]
async fn generic_statement_failed_rollback_discards_with_and_without_a_body_error(pool: PgPool) {
    let pools = pools(pool).await;
    for body_fails in [false, true] {
        super::interrupted::failed_rollback(&pools.app, async |single: &PgPool, pid| {
            let org = Uuid::new_v4();
            let result = generic_plan::organization_statement_generic(
                single,
                "SELECT current_setting('fukulow.organization_id')",
                async |connection: &mut PgConnection, sql: &str| {
                    let seen: String = sqlx::query_scalar(sql)
                        .bind(org)
                        .fetch_one(connection)
                        .await?;
                    assert_eq!(seen, org.to_string());
                    if body_fails {
                        Err(sqlx::Error::RowNotFound)
                    } else {
                        Ok(seen)
                    }
                },
            )
            .await;
            if body_fails {
                assert!(
                    matches!(result, Err(sqlx::Error::RowNotFound)),
                    "{result:?}"
                );
            } else {
                let error = result.unwrap_err();
                assert_eq!(
                    error.as_database_error().unwrap().code().as_deref(),
                    Some("22012"),
                    "{error:?}"
                );
            }
            assert_ne!(clean(single).await, pid, "failed ROLLBACK must discard");
            assert_eq!(plan_cache_mode(single).await, "auto");
        })
        .await;
    }
    pools.app.close().await;
}
