use crate::{AppState, app};
use axum::{extract::State, middleware::Next, response::IntoResponse};
use std::{future::Future, time::Duration};
use tokio::sync::watch;

pub const DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

/// Count before spawning, and release on every exit, including cancellation.
#[derive(Clone, Default)]
pub(crate) struct Work(watch::Sender<usize>);

pub(crate) struct Guard(Work);

impl Work {
    pub(crate) fn enter(&self) -> Guard {
        self.0.send_modify(|count| *count += 1);
        Guard(self.clone())
    }

    pub(crate) async fn drained(&self) {
        let _ = self.0.subscribe().wait_for(|count| *count == 0).await;
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.0.0.send_modify(|count| *count -= 1);
    }
}

#[derive(Clone, Default)]
pub struct Shutdown {
    stopped: watch::Sender<bool>,
    pub(crate) sockets: Work,
}

impl Shutdown {
    pub fn begin(&self) {
        self.stopped.send_replace(true);
    }

    pub async fn cancelled(&self) {
        let _ = self.stopped.subscribe().wait_for(|stopped| *stopped).await;
    }
}

pub(crate) async fn reject_new_requests(
    State(shutdown): State<Shutdown>,
    request: axum::extract::Request,
    next: Next,
) -> axum::response::Response {
    if *shutdown.stopped.borrow() {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(crate::auth::ErrorBody {
                error: "server shutting down".into(),
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
    let shutdown = state.shutdown.clone();
    let pool = state.pool.clone();
    let delivery = state.message_delivery.clone();
    let stop_accepting = shutdown.clone();
    let server = axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
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
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn shutdown_wakes_ten_thousand_close_tasks_concurrently() {
        let shutdown = Shutdown::default();
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..10_000 {
            let work = shutdown.sockets.enter();
            let signal = shutdown.clone();
            tasks.spawn(async move {
                let _work = work;
                signal.cancelled().await;
                // Model an unresponsive peer consuming the entire Close deadline.
                tokio::time::sleep(Duration::from_secs(1)).await;
            });
        }
        let started = tokio::time::Instant::now();
        shutdown.begin();
        shutdown.sockets.drained().await;
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        assert_eq!(started.elapsed(), Duration::from_secs(1));
    }

    #[tokio::test]
    async fn work_counts_unpolled_and_cancelled_tasks_and_nested_notification() {
        let work = Work::default();
        let guard = work.enter();
        let unpolled = tokio::spawn(async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(10), work.drained())
                .await
                .is_err()
        );
        unpolled.abort();
        assert!(unpolled.await.unwrap_err().is_cancelled());
        work.drained().await;
        let send = work.enter();
        let notification = work.enter();
        drop(send);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), work.drained())
                .await
                .is_err()
        );
        drop(notification);
        work.drained().await;
    }
}
