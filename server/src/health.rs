use crate::{auth, database, observability};
use axum::{
    extract::State,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};

#[cfg(test)]
mod tests;

#[utoipa::path(get, path = "/api/v1/health", responses((status = 200, description = "Server is responding; returns the plain-text body ok", body = String, content_type = "text/plain")))]
pub(super) async fn health() -> Result<&'static str, auth::ApiError> {
    auth::authorization::require(
        auth::Actor::Anonymous,
        auth::Action::Public,
        auth::Resource::Global,
    )?;
    tracing::trace!(
        target: observability::REVOCATION_MEASUREMENT_TARGET,
        event = "revocation_clock_sample",
        server_ms = observability::measurement_ms()
    );
    Ok("ok")
}

#[derive(Clone)]
pub(super) struct Readiness {
    pub(super) pool: sqlx::PgPool,
    pub(super) sessions: auth::SessionChanges,
    pub(super) flight:
        std::sync::Arc<tokio::sync::Mutex<Option<tokio::sync::watch::Receiver<Option<bool>>>>>,
}

impl Readiness {
    async fn check(&self) -> bool {
        let mut flight = self.flight.lock().await;
        let mut result = match flight.as_ref() {
            Some(result) if result.borrow().is_none() && result.has_changed().is_ok() => {
                result.clone()
            }
            _ => {
                let (sender, result) = tokio::sync::watch::channel(None);
                let pool = self.pool.clone();
                let sessions = self.sessions.clone();
                // The bounded check outlives any individual HTTP caller. Completed
                // results are replaced on the next call, never cached across checks.
                tokio::spawn(async move {
                    let healthy = sessions.fallback_available()
                        && database::ready(&pool).await
                        && sessions.fallback_available();
                    let _ = sender.send(Some(healthy));
                });
                *flight = Some(result.clone());
                result
            }
        };
        drop(flight);
        matches!(result.wait_for(|value| value.is_some()).await, Ok(value) if *value == Some(true))
    }
}

#[utoipa::path(get, path = "/api/v1/ready", responses(
    (status = 200, description = "Database check succeeded, connection cleanup completed and the fallback supervisor has not observed an abnormal worker exit (not a progress watchdog); returns plain-text ok", body = String, content_type = "text/plain"),
    (status = 503, description = "Readiness unavailable: error not_ready (Retry-After: 1); database check failed, acquisition/query/connection cleanup timed out, or the fallback supervisor observed an abnormal worker exit", body = auth::ErrorBody)
))]
pub(super) async fn ready(State(readiness): State<Readiness>) -> Response {
    if readiness.check().await {
        return "ok".into_response();
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "1")],
        axum::Json(auth::ErrorBody {
            error: "not_ready".into(),
        }),
    )
        .into_response()
}
