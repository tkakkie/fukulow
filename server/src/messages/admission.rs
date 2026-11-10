use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

type ChannelKey = (Uuid, Uuid);
const ADMISSION_WAIT: Duration = Duration::from_secs(1);
pub(super) const WORK_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) struct Admission {
    global: Arc<Semaphore>,
    channels: Mutex<HashMap<ChannelKey, Arc<Slots>>>,
}

struct Slots {
    watermark: Arc<Semaphore>,
    send: Arc<Semaphore>,
}

pub(super) struct Permit<'a> {
    admission: &'a Admission,
    key: ChannelKey,
    slots: Option<Arc<Slots>>,
    channel: Option<OwnedSemaphorePermit>,
    global: Option<OwnedSemaphorePermit>,
}

impl Admission {
    #[cfg(test)]
    pub(super) fn available_permits(&self) -> usize {
        self.global.available_permits()
    }

    pub(super) fn new(connections: u32) -> Self {
        Self {
            // Sends share the watermark budget: they cannot consume its headroom.
            global: Arc::new(Semaphore::new(
                (connections - connections.div_ceil(5)).min(16) as usize,
            )),
            channels: Default::default(),
        }
    }

    pub(super) async fn acquire(
        &self,
        organization: Uuid,
        channel: Uuid,
        send: bool,
    ) -> Result<Permit<'_>, sqlx::Error> {
        let key = (organization, channel);
        let slots = self
            .channels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key)
            .or_insert_with(|| {
                Arc::new(Slots {
                    watermark: Arc::new(Semaphore::new(4)),
                    send: Arc::new(Semaphore::new(1)),
                })
            })
            .clone();
        let semaphore = if send {
            slots.send.clone()
        } else {
            slots.watermark.clone()
        };
        // Construct before awaiting so cancellation also removes idle Channel entries.
        let mut permit = Permit {
            admission: self,
            key,
            slots: Some(slots),
            channel: None,
            global: None,
        };
        let deadline = tokio::time::Instant::now() + ADMISSION_WAIT;
        let operation = if send { "send" } else { "watermark" };
        permit.channel = Some(acquire(&semaphore, deadline, operation, "channel", key).await?);
        permit.global = Some(acquire(&self.global, deadline, operation, "global", key).await?);
        Ok(permit)
    }
}

async fn acquire(
    semaphore: &Arc<Semaphore>,
    deadline: tokio::time::Instant,
    operation: &str,
    scope: &str,
    key: ChannelKey,
) -> Result<OwnedSemaphorePermit, sqlx::Error> {
    match tokio::time::timeout_at(deadline, semaphore.clone().acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        _ => {
            eprintln!(
                "admission_rejected operation={operation} scope={scope} organization={} channel={}",
                key.0, key.1
            );
            Err(sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "message work admission rejected",
            )))
        }
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        drop(self.global.take());
        drop(self.channel.take());
        let mut channels = self
            .admission
            .channels
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Release the registry reference while locked, including concurrent last exits.
        drop(self.slots.take());
        if channels
            .get(&self.key)
            .is_some_and(|slots| Arc::strong_count(slots) == 1)
        {
            channels.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn channel_caps_isolate_organizations_and_release_cancelled_and_rejected_waiters() {
        let admission = Admission::new(20);
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let send = admission
            .acquire(organization, channel, true)
            .await
            .unwrap();
        let mut watermarks = Vec::new();
        for _ in 0..4 {
            watermarks.push(
                admission
                    .acquire(organization, channel, false)
                    .await
                    .unwrap(),
            );
        }
        for send in [true, false] {
            assert!(
                tokio::time::timeout(
                    Duration::from_millis(1),
                    admission.acquire(organization, channel, send)
                )
                .await
                .is_err()
            );
            let error = admission
                .acquire(organization, channel, send)
                .await
                .err()
                .unwrap();
            assert!(
                matches!(error, sqlx::Error::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock)
            );
        }
        // Identical Channel UUID in another Organization has independent limits.
        drop(
            admission
                .acquire(Uuid::new_v4(), channel, true)
                .await
                .unwrap(),
        );
        drop(
            admission
                .acquire(organization, Uuid::new_v4(), false)
                .await
                .unwrap(),
        );
        assert_eq!(admission.available_permits(), 11);
        assert_eq!(admission.channels.lock().unwrap().len(), 1);
        drop((send, watermarks));
        assert_eq!(admission.available_permits(), 16);
        assert!(admission.channels.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn sends_and_watermarks_share_global_budget_without_queueing_for_a_connection() {
        for (connections, limit) in [(1, 0), (2, 1), (20, 16), (100, 16)] {
            let admission = Admission::new(connections);
            let organization = Uuid::new_v4();
            let mut work = Vec::new();
            for index in 0..limit {
                work.push(
                    admission
                        .acquire(organization, Uuid::new_v4(), index % 2 == 0)
                        .await
                        .unwrap(),
                );
            }
            for send in [true, false] {
                assert!(
                    admission
                        .acquire(organization, Uuid::new_v4(), send)
                        .await
                        .is_err()
                );
            }
            assert_eq!(admission.channels.lock().unwrap().len(), limit);
            drop(work);
            assert_eq!(admission.available_permits(), limit);
            assert!(admission.channels.lock().unwrap().is_empty());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_last_exits_remove_idle_channel_entries() {
        let admission = Arc::new(Admission::new(20));
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut tasks = tokio::task::JoinSet::new();
        for _ in 0..128 {
            let admission = admission.clone();
            tasks.spawn(async move {
                let _permit = admission
                    .acquire(organization, channel, false)
                    .await
                    .unwrap();
                tokio::task::yield_now().await;
            });
        }
        while let Some(result) = tasks.join_next().await {
            result.unwrap();
        }
        assert_eq!(admission.available_permits(), 16);
        assert!(admission.channels.lock().unwrap().is_empty());
    }
}
