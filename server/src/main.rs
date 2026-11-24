use fukulow_server::AppState;
use sqlx::postgres::PgPoolOptions;

mod init;
mod probe;

const USAGE: &str = "Usage: fukulow-server [init --version TAG@sha256:DIGEST [--domain HOST] [--proxy caddy|nginx|none] | probe | migrate [roles] | rotate-history-generation <organization UUID | --all>]";

fn main() -> Result<(), Box<dyn std::error::Error>> {
    fukulow_server::observability::init()?;
    let command = std::env::args_os()
        .skip(1)
        .map(|arg| arg.into_string().map_err(|_| USAGE))
        .collect::<Result<Vec<_>, _>>()?;
    if let [command, args @ ..] = command.as_slice()
        && command == "init"
    {
        return Ok(init::execute(args)?);
    }
    if command.as_slice() == ["probe"] {
        return probe::execute(&listen_address()?).map_err(|_| {
            "Readiness probe failed; check FUKULOW_ADDR (host:port) and that the app is ready"
                .into()
        });
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
                .ok_or("POSTGRES_APP_PASSWORD must be set to a nonempty app database password in UTF-8")?;
            let pool = migration_pool().await?;
            return fukulow_server::database::roles(&pool, &password).await;
        }
        [command, target] if command == "rotate-history-generation" => {
            let organization = if target == "--all" {
                None
            } else {
                Some(
                    uuid::Uuid::parse_str(target)
                        .map_err(|_| "Expected an Organization UUID or --all")?,
                )
            };
            let pool = migration_pool().await?;
            fukulow_server::auth::history::rotate(&pool, organization)
                .await
                .map_err(|error| {
                    fukulow_server::observability::database_failure(&error);
                    "History generation rotation failed (diagnostics suppressed)"
                })?;
            return Ok(());
        }
        _ => return Err(USAGE.into()),
    }
    fukulow_server::messages::reactions::ReactionEmojiSet::load_embedded()?;
    let setup_token = std::env::var("FUKULOW_SETUP_TOKEN")
        .ok()
        .filter(|value| !matches!(value.trim(), "" | "setup-token-local-test-only"))
        .ok_or("FUKULOW_SETUP_TOKEN must be set to a private, random, nonblank UTF-8 token")?;
    let database_url = database_url()?;
    let origins = optional_env("FUKULOW_WS_ALLOWED_ORIGINS")?;
    let ws_allowed_origins =
        fukulow_server::realtime::AllowedOrigins::configured(origins.as_deref())?;
    let proxy_peers = optional_env("FUKULOW_TRUSTED_PROXIES")?;
    let proxy_header = optional_env("FUKULOW_CLIENT_IP_HEADER")?;
    let sign_in_throttle = fukulow_server::auth::SignInThrottle::with_proxy_config(
        proxy_peers.as_deref(),
        proxy_header.as_deref(),
    )?;
    let cookie_secure = match std::env::var("FUKULOW_COOKIE_SECURE").as_deref() {
        Ok("false") => false,
        Ok("true") | Err(std::env::VarError::NotPresent) => true,
        _ => return Err("FUKULOW_COOKIE_SECURE must be true or false".into()),
    };
    let allowed_host = match std::env::var("FUKULOW_ALLOWED_HOST") {
        Ok(value) => fukulow_server::AllowedHost::configured(&value)?,
        Err(std::env::VarError::NotPresent) => Default::default(),
        Err(_) => return Err("FUKULOW_ALLOWED_HOST must be valid text".into()),
    };
    let search_engine = match std::env::var("FUKULOW_SEARCH_ENGINE") {
        Ok(value) => fukulow_server::messages::search::SearchEngine::configured(Some(&value))?,
        Err(std::env::VarError::NotPresent) => Default::default(),
        Err(_) => return Err("FUKULOW_SEARCH_ENGINE must be disabled or d3r".into()),
    };
    let send_limit = fukulow_server::messages::SendLimit::configured(
        optional_env("FUKULOW_SEND_BURST")?.as_deref(),
        optional_env("FUKULOW_SEND_REFILL_PER_SECOND")?.as_deref(),
    )?;
    let addr = listen_address()?;
    let pool = fukulow_server::database::PoolConfig::from_env()?
        .connect(&database_url)
        .await
        .map_err(database_connection_error)?;
    fukulow_server::database::validate_server_version(&pool).await?;
    fukulow_server::database::PoolConfig::validate_app_role(&pool).await?;
    let pool_metrics = tokio::spawn(fukulow_server::database::report_pool_periodically(
        pool.clone(),
    ));
    fukulow_server::database::validate_migrations(&pool).await?;
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|_| "Listener bind failed; set FUKULOW_ADDR to a local host and available port")?;
    // Before serving; kept after the bind so the #151 baseline patch context is unchanged.
    fukulow_server::database::PoolConfig::validate_session(&pool).await?;
    tracing::info!(target: "fukulow", event = "server_listening");
    let signal = fukulow_server::signal()?;
    let shutdown = fukulow_server::shutdown::Shutdown::default();
    let invite_cleanup = tokio::spawn(fukulow_server::auth::invites::cleanup::run(pool.clone(), {
        let shutdown = shutdown.clone();
        async move { shutdown.cancelled().await }
    }));
    let reclamation = tokio::spawn(fukulow_server::channels::dms::reclamation::run(
        pool.clone(),
        {
            let shutdown = shutdown.clone();
            async move { shutdown.cancelled().await }
        },
    ));
    let receipt_expiry = tokio::spawn(fukulow_server::messages::receipts::purge_periodically(
        pool.clone(),
        shutdown.clone(),
    ));
    let metrics = tokio::spawn(fukulow_server::observability::report_periodically());
    let revocation_holds_sampler = fukulow_server::spawn_revocation_holds_sampler();
    let completed = fukulow_server::serve_with_search(
        listener,
        AppState {
            pool,
            shutdown,
            cookie_secure,
            setup_token,
            sign_in_throttle,
            account_security_throttle: Default::default(),
            message_delivery: fukulow_server::messages::Delivery::with_send_limit(send_limit),
            session_changes: Default::default(),
            session_cleanup: Default::default(),
            ws_allowed_origins,
            socket_gate: Default::default(),
        },
        search_engine,
        allowed_host,
        signal,
        fukulow_server::DRAIN_TIMEOUT,
    )
    .await?;
    if let Some(sampler) = revocation_holds_sampler {
        sampler.abort();
    }
    invite_cleanup.abort();
    let _ = invite_cleanup.await;
    receipt_expiry.abort();
    let _ = receipt_expiry.await;
    reclamation.abort();
    let _ = reclamation.await;
    metrics.abort();
    pool_metrics.abort();
    if !completed {
        tracing::warn!(target: "fukulow", event = "shutdown_drain_deadline", send_outcomes = "unknown");
        // Runtime destruction can outlast the drain deadline while blocking tasks finish.
        std::process::exit(0);
    }
    Ok(())
}

async fn migration_pool() -> Result<sqlx::PgPool, Box<dyn std::error::Error>> {
    Ok(PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url()?)
        .await
        .map_err(database_connection_error)?)
}

fn database_url() -> Result<String, &'static str> {
    std::env::var("DATABASE_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or("DATABASE_URL must be set to a PostgreSQL connection URL in UTF-8")
}

fn database_connection_error(error: sqlx::Error) -> &'static str {
    fukulow_server::observability::database_failure(&error);
    "Database connection failed (diagnostics suppressed); check DATABASE_URL syntax, credentials and PostgreSQL availability"
}

fn optional_env(name: &str) -> Result<Option<String>, String> {
    match std::env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(format!("{name} must be valid UTF-8")),
    }
}

fn listen_address() -> Result<String, String> {
    Ok(optional_env("FUKULOW_ADDR")?.unwrap_or_else(|| "0.0.0.0:8080".into()))
}
