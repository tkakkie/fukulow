use super::*;
use crate::observability::tests::Capture;
use axum::body::to_bytes;
use serde_json::json;

async fn assert_internal_response(response: Response) {
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert!(!response.headers().contains_key(header::RETRY_AFTER));
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        json!({"error": "internal error"})
    );
}

#[tokio::test]
async fn message_worker_cancellation_returns_internal_error_without_retry_after() {
    let task = tokio::spawn(std::future::pending::<()>());
    task.abort();
    let error = MessageError::from(task.await.unwrap_err());
    assert!(matches!(
        error,
        MessageError::Internal(InternalError::Unavailable)
    ));
    assert_internal_response(error.into_response()).await;
}

#[tokio::test(start_paused = true)]
async fn shared_work_deadline_remains_ten_seconds_and_returns_generic_500() {
    let start = tokio::time::Instant::now();
    let result =
        crate::messages::admission::within_work_deadline(std::future::pending::<Result<(), _>>())
            .await;
    assert_eq!(start.elapsed(), std::time::Duration::from_secs(10));
    let error = result.unwrap_err();
    assert!(matches!(
        error,
        MessageError::Internal(InternalError::Deadline)
    ));
    assert_internal_response(error.into_response()).await;
}

#[tokio::test]
async fn internal_send_failures_keep_the_original_settlement_and_waiter_response() {
    let output = Capture::default();
    for error in [
        InternalError::Deadline,
        InternalError::Invariant,
        InternalError::Unavailable,
    ] {
        let leader = MessageError::from(error);
        assert!(leader.send_outcome_unknown());
        let waiter = leader.replay();
        assert!(matches!(waiter, MessageError::ReplayedFailure));
        let (leader, waiter) = tracing::subscriber::with_default(output.subscriber(), || {
            (leader.into_response(), waiter.into_response())
        });
        assert_internal_response(leader).await;
        assert_internal_response(waiter).await;
    }
    let fields: Vec<_> = output
        .events()
        .into_iter()
        .map(|event| event["fields"].clone())
        .collect();
    let kinds: Vec<_> = fields
        .iter()
        .map(|f| {
            (
                f["kind"].as_str().unwrap(),
                f["failure_kind"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        kinds,
        [
            ("deadline", "deadline"),
            ("other", "send_replay"),
            ("other", "invariant"),
            ("other", "send_replay"),
            ("other", "unavailable"),
            ("other", "send_replay"),
        ]
    );
}

#[fukulow_test::test]
async fn dm_database_failure_retains_cause_without_changing_send_retry_or_http_contract(
    pool: sqlx::PgPool,
) {
    async fn fault(pool: &sqlx::PgPool) -> sqlx::Error {
        sqlx::raw_sql(
            "DO $$ BEGIN RAISE EXCEPTION 'secret-dm-detail' USING ERRCODE='40001'; END $$;",
        )
        .execute(pool)
        .await
        .unwrap_err()
    }

    let ordinary = MessageError::from(fault(&pool).await);
    assert!(!ordinary.send_outcome_unknown());

    let dm = MessageError::from(crate::channels::dms::SendError::from(fault(&pool).await));
    assert!(dm.send_outcome_unknown());
    let MessageError::DmDatabase(cause) = &dm else {
        panic!("expected the original DM database error");
    };
    assert_eq!(
        cause.as_database_error().unwrap().code().as_deref(),
        Some("40001")
    );
    let output = Capture::default();
    let response = tracing::subscriber::with_default(output.subscriber(), || dm.into_response());
    assert_internal_response(response).await;
    assert_eq!(output.events().len(), 1, "the DM failure is logged once");
    assert_eq!(
        output.events()[0]["fields"],
        json!({"event": "database_failure", "kind": "database"})
    );
    assert!(!output.text().contains("secret-dm-detail"));
    assert!(!output.text().contains("40001"));
}
