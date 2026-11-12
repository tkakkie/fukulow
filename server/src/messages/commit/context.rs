use super::Transaction;
use crate::{
    database::tests::{
        context::{clean, pools, settings},
        interrupted,
    },
    messages::admission::Admission,
};
use sqlx::PgPool;
use uuid::Uuid;

async fn begin(pool: &PgPool, organization: Uuid) -> Transaction {
    let permit = Admission::new(3)
        .acquire(organization, Uuid::new_v4(), true)
        .await
        .unwrap();
    Transaction::begin(pool, permit, "BEGIN", Some(organization))
        .await
        .unwrap()
}

#[sqlx::test]
async fn send_context_is_bound_and_cleared_on_commit_rollback_error_and_abort(pool: PgPool) {
    let pools = pools(pool).await;
    let mut pid = clean(&pools.app).await;
    for outcome in 0..5 {
        let organization = Uuid::new_v4();
        let mut tx = begin(&pools.app, organization).await;
        let query: String = sqlx::query_scalar("SELECT query FROM pg_stat_activity WHERE pid = $1")
            .bind(pid)
            .fetch_one(&pools.admin)
            .await
            .unwrap();
        assert_eq!(
            query,
            "SELECT set_config('fukulow.organization_id', $1, true)"
        );
        assert_eq!(
            settings(tx.connection().unwrap()).await,
            (Some(organization.to_string()), None)
        );
        if outcome >= 3 {
            sqlx::query("SELECT 1 / 0")
                .execute(tx.connection().unwrap())
                .await
                .unwrap_err();
        }
        match outcome {
            0 | 3 => tx.commit().await.unwrap(),
            1 | 4 => tx.rollback().await.unwrap(),
            // The send owner drops its transaction on a body error.
            _ => drop(tx),
        }
        let next = clean(&pools.app).await;
        if outcome == 2 {
            assert_ne!(next, pid);
        } else {
            assert_eq!(next, pid);
        }
        pid = next;
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn send_context_cancelled_begin_setting_work_and_cleanup_discard(pool: PgPool) {
    let pools = pools(pool).await;
    for statement in [
        "BEGIN",
        "SELECT set_config('fukulow.organization_id', $1, true)",
        "SELECT 314314",
        "COMMIT",
        "ROLLBACK",
    ] {
        interrupted::at(
            &pools.admin,
            &pools.app,
            statement,
            async |single: &PgPool| {
                let mut tx = begin(single, Uuid::new_v4()).await;
                sqlx::query("SELECT 314314")
                    .execute(tx.connection()?)
                    .await?;
                if statement == "ROLLBACK" {
                    tx.rollback().await
                } else {
                    tx.commit().await
                }
            },
        )
        .await;
    }
    pools.app.close().await;
}

#[sqlx::test]
async fn send_context_failed_rollback_discards_connection(pool: PgPool) {
    let pools = pools(pool).await;
    let mut tx = begin(&pools.app, Uuid::new_v4()).await;
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(tx.connection().unwrap())
        .await
        .unwrap();
    sqlx::query("SELECT pg_terminate_backend($1, 5000)")
        .bind(pid)
        .execute(&pools.admin)
        .await
        .unwrap();
    assert!(tx.rollback().await.is_err());
    assert_ne!(clean(&pools.app).await, pid);
    pools.app.close().await;
}
