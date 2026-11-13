use super::*;
use uuid::Uuid;

pub(crate) async fn set_password(pool: &sqlx::PgPool, account: Uuid, password: &str) {
    let hash = super::super::hash_password(password.into(), &PASSWORD_WORKERS)
        .await
        .unwrap();
    sqlx::query("UPDATE accounts SET password_hash=$2 WHERE id=$1")
        .bind(account)
        .bind(hash)
        .execute(pool)
        .await
        .unwrap();
}

pub(crate) async fn lock_account(tx: &mut sqlx::PgConnection, account: Uuid) {
    sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account)
        .execute(tx)
        .await
        .unwrap();
}
