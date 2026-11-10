#[cfg(test)]
use std::{future::Future, time::Duration};
use tokio::sync::watch;

/// Count before spawning, and release on every exit, including cancellation.
#[derive(Clone, Default)]
pub(crate) struct Work {
    count: watch::Sender<usize>,
    #[cfg(test)]
    pub(crate) drain_polls: watch::Sender<usize>,
}

pub(crate) struct Guard(Work);

impl Work {
    pub(crate) fn enter(&self) -> Guard {
        self.count.send_modify(|count| *count += 1);
        Guard(self.clone())
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_count(&self, expected: usize) {
        let _ = self
            .count
            .subscribe()
            .wait_for(|count| *count == expected)
            .await;
    }

    pub(crate) async fn drained(&self) {
        let mut counts = self.count.subscribe();
        let waiting = counts.wait_for(|count| *count == 0);
        #[cfg(test)]
        {
            tokio::pin!(waiting);
            // Acknowledge after the actual drain poll, including a Ready result.
            // Tests can then inspect pool ordering without racing the serve task.
            let _ = std::future::poll_fn(|cx| {
                let result = waiting.as_mut().poll(cx);
                self.drain_polls.send_modify(|polls| *polls += 1);
                result
            })
            .await;
        }
        #[cfg(not(test))]
        let _ = waiting.await;
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        self.0.count.send_modify(|count| *count -= 1);
    }
}

#[derive(Clone, Default)]
pub struct Shutdown {
    stopped: watch::Sender<bool>,
    pub(crate) sockets: Work,
}

impl Shutdown {
    pub(crate) fn is_stopped(&self) -> bool {
        *self.stopped.borrow()
    }

    pub fn begin(&self) {
        self.stopped.send_replace(true);
    }

    pub async fn cancelled(&self) {
        let _ = self.stopped.subscribe().wait_for(|stopped| *stopped).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn shutdown_watch_wakes_ten_thousand_waiters_concurrently() {
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
