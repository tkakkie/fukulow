use crate::database::test_support::{clean, pools};
use crate::database::{organization_statement, organization_statement_sql};
use crate::test_support::{Blocked, Count, wait_blocked};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

#[fukulow_test::test]
async fn statement_context_precedes_rls_and_clears_on_the_same_connection(pool: PgPool) {
    let pools = pools(pool).await;
    sqlx::raw_sql(
        "CREATE TABLE context_probe (organization_id uuid NOT NULL);
         CREATE INDEX context_probe_organization ON context_probe (organization_id);
         ALTER TABLE context_probe ENABLE ROW LEVEL SECURITY;
         GRANT SELECT ON context_probe TO fukulow_sqlx_test_app;
         CREATE POLICY context ON context_probe TO fukulow_sqlx_test_app
         USING (organization_id = NULLIF(current_setting('fukulow.organization_id', true), '')::uuid);",
    ).execute(&pools.admin).await.unwrap();
    let ids = [Uuid::new_v4(), Uuid::new_v4()];
    for id in ids {
        sqlx::query("INSERT INTO context_probe VALUES ($1)")
            .bind(id)
            .execute(&pools.admin)
            .await
            .unwrap();
    }
    let pid = clean(&pools.app).await;
    // Cover direct scans, scalar InitPlans, EXISTS and materialized authorization
    // plus LATERAL data, under both custom and cached generic plans.
    for (mode, scan) in [("force_custom_plan", "on"), ("force_generic_plan", "off")] {
        sqlx::raw_sql(&format!(
            "SET plan_cache_mode = {mode}; SET enable_seqscan = {scan}"
        ))
        .execute(&pools.app)
        .await
        .unwrap();
        for sql in [
            "SELECT organization_id FROM context_probe",
            "SELECT (SELECT organization_id FROM context_probe) AS organization_id",
            "SELECT organization_id FROM context_probe WHERE EXISTS (SELECT 1 FROM context_probe)",
            "WITH access AS MATERIALIZED (SELECT EXISTS (SELECT 1 FROM context_probe) AS visible)
             SELECT m.organization_id FROM access LEFT JOIN LATERAL
             (SELECT organization_id FROM context_probe WHERE access.visible) m ON true",
        ] {
            for id in ids.into_iter().cycle().take(12) {
                let rows: Vec<Uuid> = organization_statement(
                    &pools.app,
                    sql,
                    async |connection: &mut PgConnection, sql: &str| {
                        sqlx::query_scalar(sql).bind(id).fetch_all(connection).await
                    },
                )
                .await
                .unwrap();
                assert_eq!(rows, vec![id], "{mode}: {sql}");
                assert_eq!(clean(&pools.app).await, pid);
                let absent: i64 = sqlx::query_scalar("SELECT count(*) FROM context_probe")
                    .fetch_one(&pools.app)
                    .await
                    .unwrap();
                assert_eq!(absent, 0, "missing context must fail closed");
            }
        }
    }
    pools.app.close().await;
}

#[fukulow_test::test]
async fn statement_context_errors_and_unconfirmed_completion_discard(pool: PgPool) {
    let pools = pools(pool).await;
    let pid = clean(&pools.app).await;
    let result = organization_statement(
        &pools.app,
        "SELECT 1 / 0",
        async |connection: &mut PgConnection, sql: &str| {
            sqlx::query(sql)
                .bind(Uuid::new_v4())
                .fetch_all(connection)
                .await
        },
    )
    .await;
    assert!(result.is_err());
    assert_ne!(clean(&pools.app).await, pid);
    let sql = organization_statement_sql("SELECT 314314");
    for optional in [false, true] {
        super::interrupted::at(&pools.admin, &pools.app, &sql, async |single: &PgPool| {
            organization_statement(
                single,
                "SELECT 314314",
                async |connection: &mut PgConnection, sql: &str| {
                    let query = sqlx::query(sql).bind(Uuid::new_v4());
                    if optional {
                        query.fetch_optional(connection).await.map(|_| ())
                    } else {
                        query.fetch_all(connection).await.map(|_| ())
                    }
                },
            )
            .await?;
            Ok(())
        })
        .await;
    }
    pools.app.close().await;
}

#[fukulow_test::test]
async fn statement_context_cancelled_during_rls_read_discards_in_each_plan_mode(pool: PgPool) {
    let pools = pools(pool).await;
    let org = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO organizations (organization_id,name) VALUES ($1,'Cancellation control')",
    )
    .bind(org)
    .execute(&pools.admin)
    .await
    .unwrap();
    for mode in ["force_custom_plan", "force_generic_plan", "auto"] {
        // A replacement connection must inherit the mode too.
        let single = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .after_connect(move |connection, _| {
                Box::pin(async move {
                    sqlx::query(&format!("SET plan_cache_mode={mode}"))
                        .execute(connection)
                        .await
                        .map(|_| ())
                })
            })
            .connect_with(pools.app.connect_options().as_ref().clone())
            .await
            .unwrap();
        let read = async || {
            organization_statement(
                &single,
                "SELECT organization_id FROM organizations",
                async |connection: &mut PgConnection, sql: &str| {
                    sqlx::query_scalar::<_, Uuid>(sql)
                        .bind(org)
                        .fetch_all(connection)
                        .await
                },
            )
            .await
            .unwrap()
        };
        assert_eq!(read().await, vec![org], "{mode}: positive RLS control");
        let pid = clean(&single).await;
        let pending_pool = single.clone();
        let pending = tokio::spawn(async move {
            organization_statement(
                &pending_pool,
                "SELECT organization_id, pg_sleep(60) FROM organizations",
                async |connection: &mut PgConnection, sql: &str| {
                    sqlx::query(sql).bind(org).fetch_all(connection).await
                },
            )
            .await
        });
        wait_blocked(
            &pools.admin,
            Blocked::PidEvent(pid, "PgSleep"),
            Count::AtLeast(1),
            std::time::Duration::from_secs(5),
        )
        .await;
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        let replacement = tokio::time::timeout(std::time::Duration::from_secs(5), clean(&single))
            .await
            .unwrap();
        assert_ne!(replacement, pid, "{mode}: unconfirmed statement discarded");
        let absent: i64 = sqlx::query_scalar("SELECT count(*) FROM organizations")
            .fetch_one(&single)
            .await
            .unwrap();
        assert_eq!(
            absent, 0,
            "{mode}: replacement fails closed without context"
        );
        assert_eq!(read().await, vec![org], "{mode}: positive recovery control");
        assert_eq!(clean(&single).await, replacement);
        single.close().await;
    }
    pools.app.close().await;
}
