use fukulow_server::{AppState, app};
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let database_url = std::env::var("DATABASE_URL")?;
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
        }),
    )
    .await?;
    Ok(())
}
