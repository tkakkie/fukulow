use sqlx::postgres::PgPoolOptions;
use std::{env, time::Duration};

/// Application pool configuration; one-shot owner commands use a separate pool.
pub struct PoolConfig {
    max_connections: u32,
    acquire_timeout: Duration,
}

impl PoolConfig {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        fn optional(name: &str) -> Result<Option<String>, env::VarError> {
            match env::var(name) {
                Ok(value) => Ok(Some(value)),
                Err(env::VarError::NotPresent) => Ok(None),
                Err(error) => Err(error),
            }
        }
        Self::configured(
            optional("FUKULOW_DB_MAX_CONNECTIONS")?.as_deref(),
            optional("FUKULOW_DB_ACQUIRE_TIMEOUT_MS")?.as_deref(),
        )
        .map_err(Into::into)
    }

    pub fn configured(
        max_connections: Option<&str>,
        acquire_timeout_ms: Option<&str>,
    ) -> Result<Self, &'static str> {
        let max_connections = match max_connections {
            None => 20,
            Some(value) => value
                .parse::<u32>()
                .ok()
                .filter(|value| (3..=100).contains(value))
                .ok_or("FUKULOW_DB_MAX_CONNECTIONS must be an integer in 3..=100")?,
        };
        let acquire_timeout_ms = match acquire_timeout_ms {
            None => 1_000,
            Some(value) => value
                .parse::<u64>()
                .ok()
                .filter(|value| (1..=5_000).contains(value))
                .ok_or("FUKULOW_DB_ACQUIRE_TIMEOUT_MS must be an integer in 1..=5000")?,
        };
        Ok(Self {
            max_connections,
            acquire_timeout: Duration::from_millis(acquire_timeout_ms),
        })
    }

    pub fn options(self) -> PgPoolOptions {
        PgPoolOptions::new()
            .max_connections(self.max_connections)
            .acquire_timeout(self.acquire_timeout)
            .after_connect(|connection, _| {
                Box::pin(async move {
                    sqlx::query("SET statement_timeout = '10s'")
                        .execute(&mut *connection)
                        .await?;
                    // These are latency-bound OLTP queries. Generic visibility
                    // plans can JIT-compile unused Guest branches on every call.
                    sqlx::query("SET jit = off").execute(connection).await?;
                    Ok(())
                })
            })
    }
}

#[cfg(test)]
mod tests;
