use fukulow_server::AppState;
use sqlx::postgres::PgPoolOptions;

mod probe;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let command: Vec<String> = std::env::args().skip(1).collect();
    if command.as_slice() == ["probe"] {
        let addr = std::env::var("FUKULOW_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
        return probe::execute(&addr).map_err(|_| "Readiness probe failed".into());
    }
    server_main(command)
}

#[tokio::main]
async fn server_main(command: Vec<String>) -> Result<(), Box<dyn std::error::Error>> {
    match command.as_slice() {
        [] => {}
        [command] if command == "migrate" => {
            let pool = migration_pool().await?;
            fukulow_server::database::migrate_and_grant(&pool).await?;
            return Ok(());
        }
        [command, action] if command == "migrate" && action == "roles" => {
            let password = std::env::var("POSTGRES_APP_PASSWORD")
                .ok()
                .filter(|value| !value.is_empty())
                .ok_or("POSTGRES_APP_PASSWORD must be nonempty")?;
            let pool = migration_pool().await?;
            return fukulow_server::database::roles(&pool, &password).await;
        }
        _ => return Err("Usage: fukulow-server [probe | migrate [roles]]".into()),
    }
    let setup_token = match std::env::var("FUKULOW_SETUP_TOKEN") {
        Ok(token) if token.trim().is_empty() || token.trim() == "setup-token-local-test-only" => {
            return Err(
                "FUKULOW_SETUP_TOKEN must be nonblank and not the published example".into(),
            );
        }
        Ok(token) => token,
        Err(_) => return Err("FUKULOW_SETUP_TOKEN must be set to a nonempty value".into()),
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
    let send_limit = fukulow_server::messages::SendLimit::configured(
        std::env::var("FUKULOW_SEND_BURST").ok().as_deref(),
        std::env::var("FUKULOW_SEND_REFILL_PER_SECOND")
            .ok()
            .as_deref(),
    )?;
    let pool = fukulow_server::database::PoolConfig::from_env()?
        .options()
        .connect(&database_url)
        .await?;
    fukulow_server::database::validate_migrations(&pool).await?;
    let addr = std::env::var("FUKULOW_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("listening on {addr}");
    let signal = fukulow_server::signal()?;
    let completed = fukulow_server::serve(
        listener,
        AppState {
            pool,
            shutdown: Default::default(),
            cookie_secure,
            setup_token,
            sign_in_throttle,
            message_delivery: fukulow_server::messages::Delivery::with_send_limit(send_limit),
            session_changes: Default::default(),
            session_cleanup: Default::default(),
            ws_allowed_origins,
            socket_gate: Default::default(),
        },
        signal,
        fukulow_server::DRAIN_TIMEOUT,
    )
    .await?;
    if !completed {
        eprintln!("shutdown drain deadline expired; send outcomes may be unknown; exiting");
        // Runtime destruction can outlast the drain deadline while blocking tasks finish.
        std::process::exit(0);
    }
    Ok(())
}

async fn migration_pool() -> Result<sqlx::PgPool, Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL")?;
    Ok(PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await?)
}
