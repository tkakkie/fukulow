use super::*;
use crate::observability::tests::Capture;
use axum::body::to_bytes;
use serde_json::json;

#[tokio::test]
async fn http_worker_cancellation_returns_redacted_500_without_retry_after() {
    let task = tokio::spawn(std::future::pending::<()>());
    task.abort();
    let error = task.await.unwrap_err();
    let output = Capture::default();
    let response = tracing::subscriber::with_default(output.subscriber(), || {
        ApiError::from(error).into_response()
    });
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::RETRY_AFTER));
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        json!({"error": "internal error"})
    );
    assert_eq!(
        output.events()[0]["fields"],
        json!({
            "event": "database_failure", "kind": "other", "failure_kind": "unavailable"
        })
    );
}
