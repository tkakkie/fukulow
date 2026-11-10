use fukulow_server::AppState;
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let setup_token = match std::env::var("FUKULOW_SETUP_TOKEN") {
        Ok(token) if token.is_empty() => return Err("FUKULOW_SETUP_TOKEN must not be empty".into()),
        Ok(token) => Some(token),
        Err(std::env::VarError::NotPresent) => None,
        Err(error) => return Err(error.into()),
    };
    let database_url = std::env::var("DATABASE_URL")?;
    let origins = std::env::var("FUKULOW_WS_ALLOWED_ORIGINS").ok();
    let ws_allowed_origins =
        fukulow_server::realtime::AllowedOrigins::configured(origins.as_deref())?;
    let proxy_peers = std::env::var("FUKULOW_TRUSTED_PROXIES").ok();
    let proxy_header = std::env::var("FUKULOW_CLIENT_IP_HEADER").ok();
    let sign_in_throttle = fukulow_server::auth::SignInThrottle::with_proxy_config(
        proxy_peers.as_deref(),
        proxy_header.as_deref(),
    )?;
    let cookie_secure = match std::env::var("FUKULOW_COOKIE_SECURE").as_deref() {
        Ok("false") => false,
        Ok("true") | Err(std::env::VarError::NotPresent) => true,
        _ => return Err("FUKULOW_COOKIE_SECURE must be true or false".into()),
    };
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .connect(&database_url)
        .await?;
    migrate(&pool).await?;
    let addr = std::env::var("FUKULOW_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("listening on {addr}");
    let signal = fukulow_server::shutdown::signal()?;
    let completed = fukulow_server::shutdown::serve(
        listener,
        AppState {
            pool,
            shutdown: Default::default(),
            cookie_secure,
            setup_token,
            sign_in_throttle,
            message_delivery: Default::default(),
            session_changes: Default::default(),
            session_cleanup: Default::default(),
            ws_allowed_origins,
        },
        signal,
        fukulow_server::shutdown::DRAIN_TIMEOUT,
    )
    .await?;
    if !completed {
        eprintln!("shutdown drain deadline expired; send outcomes may be unknown; exiting");
        // Runtime destruction can wait indefinitely for blocking tasks.
        std::process::exit(0);
    }
    Ok(())
}

async fn migrate(pool: &sqlx::PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    let mut connection = pool.acquire().await?;
    // Discard the migration-only setting and any SQLx advisory lock on every exit,
    // including errors and cancellation, rather than returning them to the pool.
    connection.close_on_drop();
    sqlx::query("SET lock_timeout = '5s'")
        .execute(&mut *connection)
        .await?;
    sqlx::migrate!().run(&mut *connection).await
}

#[cfg(test)]
mod tests {
    use super::migrate;
    use sqlx::{
        PgPool,
        migrate::{Migrate, MigrateError},
        postgres::PgPoolOptions,
    };
    use std::time::{Duration, Instant};

    async fn startup_pool(pool: &PgPool) -> PgPool {
        PgPoolOptions::new()
            .max_connections(1)
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .unwrap()
    }

    async fn lock_timeout(pool: &PgPool) -> String {
        sqlx::query_scalar("SHOW lock_timeout")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn startup_migrations_succeed_and_keep_timeout_out_of_application_pool(pool: PgPool) {
        let pool = startup_pool(&pool).await;
        let original_timeout = lock_timeout(&pool).await;
        for _ in 0..2 {
            migrate(&pool).await.unwrap();
            assert_eq!(lock_timeout(&pool).await, original_timeout);
        }
        let applied: i64 =
            sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(applied, sqlx::migrate!().iter().count() as i64);
        pool.close().await;
    }

    #[sqlx::test(migrations = false)]
    async fn startup_migrations_timeout_on_advisory_lock_and_can_retry(pool: PgPool) {
        let startup = startup_pool(&pool).await;
        let original_timeout = lock_timeout(&startup).await;
        let mut holder = pool.acquire().await.unwrap();
        holder.close_on_drop();
        // Use SQLx's own lock API so the holder and startup use the same lock key.
        holder.lock().await.unwrap();

        let started = Instant::now();
        let error = tokio::time::timeout(Duration::from_secs(15), migrate(&startup))
            .await
            .expect("startup migration must not wait indefinitely for the advisory lock")
            .unwrap_err();
        assert!(started.elapsed() >= Duration::from_secs(4));
        match error {
            MigrateError::Execute(error) => assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some("55P03")
            ),
            error => panic!("expected advisory lock timeout, got {error:?}"),
        }
        assert_eq!(lock_timeout(&startup).await, original_timeout);
        let history: Option<String> =
            sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations')::text")
                .fetch_one(&startup)
                .await
                .unwrap();
        assert_eq!(history, None);

        holder.unlock().await.unwrap();
        tokio::time::timeout(Duration::from_secs(15), migrate(&startup))
            .await
            .expect("startup migration must succeed after releasing the advisory lock")
            .unwrap();
        assert_eq!(lock_timeout(&startup).await, original_timeout);
        let applied: i64 =
            sqlx::query_scalar("SELECT count(*) FROM _sqlx_migrations WHERE success")
                .fetch_one(&startup)
                .await
                .unwrap();
        assert_eq!(applied, sqlx::migrate!().iter().count() as i64);
        startup.close().await;
    }

    #[sqlx::test(migrations = false)]
    async fn startup_migrations_timeout_on_ddl_lock_and_can_retry_without_partial_changes(
        pool: PgPool,
    ) {
        let mut initial = sqlx::migrate!();
        initial
            .migrations
            .to_mut()
            .retain(|migration| migration.version < 202611090075);
        initial.run(&pool).await.unwrap();
        let startup = startup_pool(&pool).await;
        let original_timeout = lock_timeout(&startup).await;
        let mut reader = pool.begin().await.unwrap();
        sqlx::query("LOCK TABLE sessions IN ACCESS SHARE MODE")
            .execute(&mut *reader)
            .await
            .unwrap();

        let started = Instant::now();
        let error = tokio::time::timeout(Duration::from_secs(15), migrate(&startup))
            .await
            .expect("startup migration must not wait indefinitely for a DDL lock")
            .unwrap_err();
        assert!(started.elapsed() >= Duration::from_secs(4));
        match error {
            MigrateError::ExecuteMigration(error, version) => {
                assert_eq!(version, 202611090075);
                assert_eq!(
                    error.as_database_error().unwrap().code().as_deref(),
                    Some("55P03")
                );
            }
            error => panic!("expected migration lock timeout, got {error:?}"),
        }
        assert_eq!(lock_timeout(&startup).await, original_timeout);
        let unchanged: (bool, i64) = sqlx::query_as(
            "SELECT to_regclass('public.sessions_expiry') IS NOT NULL, \
             (SELECT count(*) FROM _sqlx_migrations WHERE version = 202611090075)",
        )
        .fetch_one(&startup)
        .await
        .unwrap();
        assert_eq!(unchanged, (true, 0));

        reader.rollback().await.unwrap();
        tokio::time::timeout(Duration::from_secs(15), migrate(&startup))
            .await
            .expect("failed migration must release its advisory lock for retry")
            .unwrap();
        assert_eq!(lock_timeout(&startup).await, original_timeout);
        let applied: (bool, bool) = sqlx::query_as(
            "SELECT to_regclass('public.sessions_expiry') IS NULL, \
             (SELECT success FROM _sqlx_migrations WHERE version = 202611090075)",
        )
        .fetch_one(&startup)
        .await
        .unwrap();
        assert_eq!(applied, (true, true));
        startup.close().await;
    }
}
