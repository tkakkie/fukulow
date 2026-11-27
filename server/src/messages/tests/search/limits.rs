use super::*;
use crate::messages::search::BURST;
use futures_util::FutureExt;

#[fukulow_test::test]
async fn search_accepts_the_burst_then_returns_retry_after(pool: PgPool) {
    let f = Fixture::with_engine(pool, SearchEngine::configured(Some("d3r")).unwrap()).await;
    f.engine.freeze_test_clock();

    for _ in 0..BURST {
        let response = get(&f.app, f.org, &f.token, Some("needle"), None, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key(header::RETRY_AFTER));
    }

    let response = get(&f.app, f.org, &f.token, Some("needle"), None, None).await;
    assert_eq!(response.headers()[header::RETRY_AFTER], "1");
    error(
        response,
        StatusCode::TOO_MANY_REQUESTS,
        "search_rate_limited",
    )
    .await;
}

#[fukulow_test::test]
async fn search_rejects_concurrent_member_before_checkout_and_releases_on_completion_and_drop(
    pool: PgPool,
) {
    let f = Fixture::with_engine(pool, SearchEngine::configured(Some("d3r")).unwrap()).await;
    let message = id(&f.post(f.public, "needle").await);
    let auth = membership::captured_auth(&f.pools.app, &f.token).await;
    let search = || {
        with_captured_auth(
            AppState::with_test_pool(f.pools.app.clone()),
            f.engine.clone(),
            auth.clone(),
        )
    };
    let other = member(&f.pools.admin, f.org, Uuid::new_v4()).await;
    let closed_pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy_with((*f.pools.app.connect_options()).clone());
    closed_pool.close().await;
    let mut pending = Box::pin(search());
    assert!(pending.as_mut().now_or_never().is_none());
    let response = with_captured_auth(
        AppState::with_test_pool(closed_pool),
        f.engine.clone(),
        auth.clone(),
    )
    .await;
    assert_eq!(response.headers()[header::RETRY_AFTER], "1");
    error(
        response,
        StatusCode::TOO_MANY_REQUESTS,
        "search_rate_limited",
    )
    .await;
    assert_eq!(
        ids(&page(&f, &other, "needle", None, None).await),
        [message]
    );
    let response = pending.await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::RETRY_AFTER));
    assert_eq!(ids(&body(response).await), [message]);

    let mut cancelled = Box::pin(search());
    assert!(cancelled.as_mut().now_or_never().is_none());
    drop(cancelled);
    assert_eq!(
        ids(&page(&f, &f.token, "needle", None, None).await),
        [message]
    );
}
