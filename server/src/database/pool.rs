use sqlx::{
    PgConnection, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
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
            None => 5_000,
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

    /// Crate-only: app pools are built with `connect`/`connect_with` so their
    /// connections carry the session startup parameters.
    pub(crate) fn options(self) -> PgPoolOptions {
        PgPoolOptions::new()
            .max_connections(self.max_connections)
            .acquire_timeout(self.acquire_timeout)
    }

    pub async fn connect(self, url: &str) -> Result<PgPool, sqlx::Error> {
        self.connect_with(url.parse()?).await
    }

    /// Builds an application pool. Every app pool must be built here so its
    /// connections carry the session startup parameters.
    pub async fn connect_with(self, options: PgConnectOptions) -> Result<PgPool, sqlx::Error> {
        self.options().connect_with(session(options)).await
    }

    pub async fn validate_app_role(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
        let mut connection = super::acquire(pool).await.map_err(|_| APP_ROLE_ERROR)?;
        validate_app_role(&mut connection).await.map_err(Into::into)
    }

    /// Startup check: fails unless app connections carry the session settings.
    pub async fn validate_session(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
        validate_session_settings(pool).await
    }
}

const APP_ROLE_ERROR: &str = "App database role must be a non-superuser without BYPASSRLS, \
    ownership of relations in public, or role memberships in either direction";

async fn validate_app_role(connection: &mut PgConnection) -> Result<(), &'static str> {
    // The current database owner is an implicit member of pg_database_owner.
    let restricted: bool = sqlx::query_scalar(
        "SELECT NOT (r.rolsuper OR r.rolbypassrls)
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relowner = r.oid
            )
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid
            )
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_database d
                WHERE d.datname = pg_catalog.current_database() AND d.datdba = r.oid
            )
         FROM pg_catalog.pg_roles r WHERE r.rolname = current_user",
    )
    .fetch_one(connection)
    .await
    .map_err(|_| APP_ROLE_ERROR)?;
    if restricted {
        Ok(())
    } else {
        Err(APP_ROLE_ERROR)
    }
}

/// App session settings, sent as startup parameters: no per-connection round
/// trip. Never applied to the one-shot owner (migration) connection.
pub(super) fn session(options: PgConnectOptions) -> PgConnectOptions {
    // Bounds ordinary queries and lock waits. jit: these are latency-bound OLTP
    // queries; generic visibility plans can JIT-compile unused Guest branches on
    // every call.
    options.options([("statement_timeout", "10s"), ("jit", "off")])
}

/// Fails startup unless app connections actually carry the session settings,
/// so a misconfigured connection cannot run unbounded statements.
async fn validate_session_settings(pool: &PgPool) -> Result<(), Box<dyn std::error::Error>> {
    let settings: (String, String) =
        sqlx::query_as("SELECT current_setting('statement_timeout'), current_setting('jit')")
            .fetch_one(
                &mut *super::acquire(pool)
                    .await
                    .map_err(|_| "Cannot acquire session settings connection")?,
            )
            .await
            .map_err(|_| "Cannot read app session settings")?;
    if settings.0 != "10s" || settings.1 != "off" {
        return Err("App database connection must have statement_timeout = 10s and jit = off; \
             build the app pool with PoolConfig and keep its startup parameters (a proxy or pooler may drop them)"
            .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
