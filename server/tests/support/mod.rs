use fukulow_server::AppState;
use sqlx::PgPool;

pub fn app_state(pool: PgPool) -> AppState {
    AppState {
        pool,
        shutdown: Default::default(),
        cookie_secure: true,
        setup_token: "setup-token-test-only".into(),
        sign_in_throttle: Default::default(),
        account_security_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        ws_allowed_origins: Default::default(),
        socket_gate: Default::default(),
    }
}
