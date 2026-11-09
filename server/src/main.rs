use fukulow_server::{AppState, app};
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
    sqlx::migrate!().run(&pool).await?;
    let addr = std::env::var("FUKULOW_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("listening on {addr}");
    axum::serve(
        listener,
        app(AppState {
            pool,
            cookie_secure,
            setup_token,
            sign_in_throttle,
            message_delivery: Default::default(),
            session_changes: Default::default(),
            ws_allowed_origins,
        })
        .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}
