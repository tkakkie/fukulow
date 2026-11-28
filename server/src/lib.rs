mod allowed_host;
pub mod auth;
pub mod channels;
pub mod database;
mod health;
pub mod messages;
pub mod observability;
pub mod openapi;
pub mod realtime;
mod security_headers;
pub mod shutdown;
mod static_assets;

#[cfg(test)]
mod pool_stats_tests;
#[cfg(test)]
mod sql_fragment_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod websocket_test_support;

pub use allowed_host::AllowedHost;
use axum::{
    Router,
    extract::State,
    http::header,
    middleware::{self, Next},
    response::IntoResponse,
    routing::get,
};
use shutdown::Shutdown;
use std::{
    future::Future,
    sync::{Mutex, MutexGuard, PoisonError},
    time::Duration,
};

pub(crate) fn report_internal_failure(error: &database::InternalError) {
    use database::InternalError;
    match error {
        InternalError::Db(error) => observability::database_failure(error),
        InternalError::Saturated => {} // The admission site already counted the refusal.
        InternalError::Deadline => observability::internal_failure("deadline", "deadline"),
        InternalError::Invariant => observability::internal_failure("invariant", "invariant"),
        InternalError::Unavailable => observability::internal_failure("other", "unavailable"),
    }
}

pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

#[inline]
pub(crate) fn lock_ignoring_poison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[inline]
pub(crate) fn get_mut_ignoring_poison<T>(mutex: &mut Mutex<T>) -> &mut T {
    mutex.get_mut().unwrap_or_else(PoisonError::into_inner)
}

pub fn spawn_revocation_holds_sampler() -> Option<tokio::task::JoinHandle<()>> {
    observability::spawn_revocation_holds_sampler(channels::activity::revocation_hold_counts)
}

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::PgPool,
    pub shutdown: shutdown::Shutdown,
    pub cookie_secure: bool,
    pub setup_token: String,
    pub sign_in_throttle: auth::SignInThrottle,
    pub account_security_throttle: auth::AccountSecurityThrottle,
    pub message_delivery: messages::Delivery,
    pub session_changes: auth::SessionChanges,
    pub session_cleanup: auth::SessionCleanup,
    pub ws_allowed_origins: realtime::AllowedOrigins,
    pub socket_gate: realtime::SocketGate,
}

#[cfg(test)]
impl AppState {
    /// Application queries run as the restricted, RLS-subject test role (#314);
    /// keep fixtures, DDL and fault injection on the administrative pool passed in.
    pub(crate) async fn for_test(pool: sqlx::PgPool) -> Self {
        Self::with_test_pool(test_app_pool(pool).await)
    }

    /// Test state over `pool` as given (e.g. a pool that never connects).
    pub(crate) fn with_test_pool(pool: sqlx::PgPool) -> Self {
        Self {
            pool,
            cookie_secure: true,
            setup_token: "setup-token-test-only".into(),
            sign_in_throttle: Default::default(),
            account_security_throttle: Default::default(),
            message_delivery: Default::default(),
            session_changes: Default::default(),
            session_cleanup: Default::default(),
            shutdown: Default::default(),
            ws_allowed_origins: Default::default(),
            socket_gate: Default::default(),
        }
    }
}

/// Convert a superuser pool to the restricted application pool. Reuse a
/// non-superuser pool only if it meets the test app role restrictions.
#[cfg(test)]
pub(crate) async fn test_app_pool(pool: sqlx::PgPool) -> sqlx::PgPool {
    // A pool that never connects must use `AppState::with_test_pool`: probing it
    // here waits out sqlx's 30 s acquire timeout, so an inspection error fails.
    let inspection_error =
        "inspect the test pool role (use AppState::with_test_pool for a pool that never connects)";
    let mut connection = pool.acquire().await.expect(inspection_error);
    let (role, superuser, bypass_rls): (String, bool, bool) = sqlx::query_as(
        "SELECT rolname::text, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(&mut *connection)
    .await
    .expect(inspection_error);
    if !superuser {
        assert!(!bypass_rls, "test app pool role {role} has BYPASSRLS");
        test_support::assert_restricted_role(&mut connection, &role).await;
    }
    drop(connection);
    if superuser {
        test_support::TestPools::new(pool).await.app
    } else {
        pool
    }
}

pub fn app(state: AppState) -> Router {
    app_with_search(state, messages::search::SearchEngine::Disabled)
}

fn app_with_search(state: AppState, search_engine: messages::search::SearchEngine) -> Router {
    configured_app(state, search_engine, AllowedHost::default())
}

fn configured_app(
    state: AppState,
    search_engine: messages::search::SearchEngine,
    allowed_host: AllowedHost,
) -> Router {
    state.session_changes.set_activity(std::sync::Arc::new(
        state.message_delivery.channel_access.activity.clone(),
    ));
    state
        .session_changes
        .set_subscription_recheck(std::sync::Arc::new(
            state.message_delivery.channel_access.clone(),
        ));
    let cookie_secure = state.cookie_secure;
    let readiness = health::Readiness {
        pool: state.pool.clone(),
        sessions: state.session_changes.clone(),
        flight: Default::default(),
    };
    Router::new()
        .route("/api/v1/health", get(health::health))
        .route("/api/v1/ready", get(health::ready).with_state(readiness))
        .route("/api/v1/setup", get(auth::setup_status).post(auth::setup))
        .route(
            "/api/v1/session",
            axum::routing::post(auth::sign_in).delete(auth::sign_out),
        )
        .route(
            "/api/v1/native/session",
            axum::routing::post(auth::native_sign_in),
        )
        .route("/api/v1/me", get(auth::me))
        .route(
            "/api/v1/me/password",
            axum::routing::put(auth::security::change_password),
        )
        .route(
            "/api/v1/me/sessions/revoke-others",
            axum::routing::post(auth::security::revoke_others),
        )
        .route("/api/v1/orgs/{org}/me", get(auth::organization_me))
        .route(
            "/api/v1/orgs/{org}/startup",
            get(messages::startup::get_startup),
        )
        .merge(channels::sections::router(
            state.message_delivery.channel_access.activity.clone(),
        ))
        .route(
            "/api/v1/orgs/{org}/members",
            get(auth::members::list_members::<channels::members::MemberListVisibility>),
        )
        .route(
            "/api/v1/orgs/{org}/message-authors",
            axum::routing::post(messages::authors::lookup_authors),
        )
        .route(
            "/api/v1/orgs/{org}/search",
            get(messages::search::search).layer(axum::Extension(search_engine)),
        )
        .route(
            "/api/v1/orgs/{org}/members/{id}/deactivate",
            axum::routing::post(auth::members::deactivate::<channels::members::RoleChangeGuard>),
        )
        .route(
            "/api/v1/orgs/{org}/members/{id}/role",
            axum::routing::patch(auth::members::change_role::<channels::members::RoleChangeGuard>),
        )
        .route(
            "/api/v1/orgs/{org}/invites",
            get(auth::invites::management::list_invites).post(auth::invites::create_invite),
        )
        .route(
            "/api/v1/orgs/{org}/invites/{id}",
            axum::routing::delete(auth::invites::management::revoke_invite),
        )
        .route(
            "/api/v1/orgs/{org}/invites/accept",
            axum::routing::post(auth::invites::accept_invite),
        )
        .route(
            "/api/v1/orgs/{org}/dms",
            get(messages::dms::list).post(messages::dms::open),
        )
        .route(
            "/api/v1/orgs/{org}/dms/changes",
            get(channels::dms::discovery::changes),
        )
        .route(
            "/api/v1/orgs/{org}/channels",
            get(messages::list_channels).post(channels::create_channel),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}",
            get(channels::archive::get_channel).patch(channels::archive::update_channel),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/members",
            get(channels::members::list).post(channels::members::add),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/members/{member_id}",
            axum::routing::delete(channels::members::remove)
                .patch(channels::members::change_manager),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/events",
            get(messages::list_channel_events),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/messages",
            get(messages::list_messages)
                .post(messages::send_message)
                // 4000 control characters escape to 6 bytes each in JSON, so the global 16 KiB would reject valid bodies.
                .layer(axum::extract::DefaultBodyLimit::max(32 * 1024)),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/read",
            axum::routing::put(messages::mark_channel_read),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/read",
            axum::routing::put(messages::mark_topic_read),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/reply-counts",
            axum::routing::post(messages::reply_counts),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/chain",
            get(messages::reply_chain),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/move",
            axum::routing::post(messages::move_chain),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/timeline",
            get(messages::list_timeline),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/topics",
            get(messages::list_topics),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}",
            get(messages::topic_summary),
        )
        .route(
            "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/messages",
            get(messages::topic_history),
        )
        .route("/api/v1/orgs/{org}/ws", get(realtime::upgrade))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .fallback(static_assets::static_handler)
        .layer(axum::middleware::from_fn_with_state(
            state.shutdown.clone(),
            reject_new_requests,
        ))
        .layer(middleware::from_fn_with_state(
            allowed_host,
            allowed_host::check,
        ))
        .layer(middleware::from_fn_with_state(
            cookie_secure,
            security_headers::security_headers,
        ))
        .layer(middleware::from_fn(observability::request))
        .with_state(state)
}

pub(crate) async fn reject_new_requests(
    State(shutdown): State<Shutdown>,
    request: axum::extract::Request,
    next: Next,
) -> axum::response::Response {
    if shutdown.is_stopped() {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            [
                (
                    header::RETRY_AFTER,
                    rand::random_range(1..=5_u64).to_string(),
                ),
                (header::CACHE_CONTROL, "no-store".to_owned()),
            ],
            axum::Json(crate::auth::ErrorBody {
                error: "shutting_down".into(),
            }),
        )
            .into_response();
    }
    next.run(request).await
}

/// The caller must terminate the process on expiry, without waiting for pool/runtime teardown.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    signal: impl Future<Output = ()>,
    deadline: Duration,
) -> std::io::Result<bool> {
    serve_with_search(
        listener,
        state,
        messages::search::SearchEngine::Disabled,
        AllowedHost::default(),
        signal,
        deadline,
    )
    .await
}

pub async fn serve_with_search<L>(
    listener: L,
    state: AppState,
    search_engine: messages::search::SearchEngine,
    allowed_host: AllowedHost,
    signal: impl Future<Output = ()>,
    deadline: Duration,
) -> std::io::Result<bool>
where
    L: axum::serve::Listener<Addr = std::net::SocketAddr>,
    std::net::SocketAddr:
        for<'a> axum::extract::connect_info::Connected<axum::serve::IncomingStream<'a, L>>,
{
    let shutdown = state.shutdown.clone();
    let pool = state.pool.clone();
    let delivery = state.message_delivery.clone();
    let stop_accepting = shutdown.clone();
    let server = axum::serve(
        listener,
        configured_app(state, search_engine, allowed_host)
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move { stop_accepting.cancelled().await })
    .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => { result?; return Ok(true); }
        _ = signal => {}
    }
    let bound = tokio::time::Instant::now() + deadline;
    shutdown.begin();
    let drain = async {
        server.await?;
        // HTTP completion alone misses persistence whose caller disconnected,
        // and the notification spawned immediately before persistence completes.
        delivery.drained().await;
        shutdown.sockets.drained().await;
        pool.close().await;
        Ok::<_, std::io::Error>(())
    };
    match tokio::time::timeout_at(bound, drain).await {
        Ok(result) => {
            result?;
            Ok(true)
        }
        Err(_) => Ok(false),
    }
}

/// Register both handlers before accepting any connections.
pub fn signal() -> std::io::Result<impl Future<Output = ()>> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    Ok(async move {
        tokio::select! {
            _ = term.recv() => {}
            _ = interrupt.recv() => {}
        }
    })
}

#[cfg(test)]
mod tests {
    mod test_pool;
    use super::*;
    use axum::{body::Body, http::Request, response::Response};
    use tower::ServiceExt;

    pub(super) async fn get(path: &str) -> Response {
        get_encoded(path, None).await
    }

    pub(super) async fn get_encoded(path: &str, encoding: Option<&str>) -> Response {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@localhost/unused")
            .unwrap();
        let mut request = Request::get(path);
        if let Some(encoding) = encoding {
            request = request.header(header::ACCEPT_ENCODING, encoding);
        }
        app(AppState {
            pool,
            cookie_secure: true,
            setup_token: "setup-token-test-only".into(),
            sign_in_throttle: Default::default(),
            account_security_throttle: Default::default(),
            message_delivery: Default::default(),
            session_changes: Default::default(),
            session_cleanup: Default::default(),
            shutdown: Default::default(),
            ws_allowed_origins: Default::default(),
            socket_gate: Default::default(),
        })
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
    }
}
