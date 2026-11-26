//! Time acquisition from an empty application pool for the #1066 harness.
use fukulow_server::database::PoolConfig;
use sqlx::Connection;
use std::{
    io::{self, Write},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let samples: usize = std::env::args()
        .nth(1)
        .ok_or("Missing sample count")?
        .parse()?;
    let bootstrap = PoolConfig::from_env()?
        .connect(&std::env::var("DATABASE_URL")?)
        .await
        .map_err(|_| "Could not initialize the application pool")?;
    PoolConfig::validate_session(&bootstrap).await?;
    // PoolConfig connects eagerly. Copy its exact options into a lazy pool so
    // no connection from session validation can race back into the timed pool.
    let pool = bootstrap
        .options()
        .clone()
        .connect_lazy_with(bootstrap.connect_options().as_ref().clone());
    bootstrap.close().await;

    let stdout = io::stdout();
    let mut output = stdout.lock();
    for sample in 1..=samples {
        if pool.size() != 0 {
            return Err("Expected an empty pool before each sample".into());
        }
        let started_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
        let start = Instant::now();
        let acquired = pool.acquire().await;
        let elapsed_ns = start.elapsed().as_nanos();
        let finished_ms = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
        let ok = acquired.is_ok();
        writeln!(
            output,
            r#"{{"sample":{sample},"startedMs":{started_ms},"finishedMs":{finished_ms},"elapsedNs":{elapsed_ns},"ok":{ok}}}"#
        )?;
        output.flush()?;
        // Detach to keep the next acquisition fresh. Close outside the timer.
        acquired
            .map_err(|_| "Connection acquisition failed")?
            .detach()
            .close()
            .await
            .map_err(|_| "Could not close the sampled connection")?;
        // Spread the samples through the steady traffic window. Exclude the pause.
        if sample < samples {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    Ok(())
}
