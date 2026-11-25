use super::MessageError;
use crate::lock_ignoring_poison;
use crate::observability::{Admission as Rejection, admission};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

type ChannelKey = (Uuid, Uuid);
const ADMISSION_WAIT: Duration = Duration::from_secs(1);
const SEND_ADMISSION_WAIT: Duration = Duration::from_secs(30);
pub(super) const CHANNEL_QUEUE_CAP: usize = 256;
pub(super) const GLOBAL_QUEUE_CAP: usize = 2_048;
pub(super) const WORK_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn within_work_deadline<T>(
    work: impl Future<Output = Result<T, MessageError>>,
) -> Result<T, MessageError> {
    tokio::time::timeout(WORK_TIMEOUT, work)
        .await
        .map_err(|_| MessageError::Database(sqlx::Error::Io(std::io::ErrorKind::TimedOut.into())))?
}

pub(super) struct Admission {
    send: Arc<Semaphore>,
    watermark: Arc<Semaphore>,
    channels: Mutex<HashMap<ChannelKey, Arc<Slots>>>,
    queued: Mutex<Queued>,
    #[cfg(test)]
    hold_watermark_timeouts: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    watermark_events: Mutex<Vec<(Uuid, Uuid, &'static str)>>,
}

#[derive(Default)]
struct Queued {
    total: usize,
    channels: HashMap<ChannelKey, usize>,
}

pub(super) struct SendWaiter {
    admission: Arc<Admission>,
    key: ChannelKey,
}

impl SendWaiter {
    pub(super) async fn acquire(self) -> Result<Permit, super::MessageError> {
        self.admission
            .acquire(self.key.0, self.key.1, true)
            .await
            .map_err(|_| super::MessageError::AdmissionRejected)
        // Drop the queue reservation once work is admitted (or rejected).
    }
}

impl Drop for SendWaiter {
    fn drop(&mut self) {
        let mut queued = lock_ignoring_poison(&self.admission.queued);
        queued.total -= 1;
        if let Some(count) = queued.channels.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                queued.channels.remove(&self.key);
            }
        }
    }
}

struct Slots {
    watermark: Arc<Semaphore>,
    send: Arc<Semaphore>,
}

pub(super) struct Permit {
    admission: Arc<Admission>,
    key: ChannelKey,
    slots: Option<Arc<Slots>>,
    channel: Option<OwnedSemaphorePermit>,
    global: Option<OwnedSemaphorePermit>,
}

impl Admission {
    #[cfg(test)]
    pub(super) fn record_watermark_event(
        &self,
        organization: Uuid,
        channel: Uuid,
        event: &'static str,
    ) {
        self.watermark_events
            .lock()
            .unwrap()
            .push((organization, channel, event));
    }

    #[cfg(test)]
    pub(super) fn take_watermark_events(&self) -> Vec<(Uuid, Uuid, &'static str)> {
        std::mem::take(&mut *self.watermark_events.lock().unwrap())
    }

    #[cfg(test)]
    pub(super) fn hold_watermark_timeouts(&self) {
        self.hold_watermark_timeouts
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    #[cfg(test)]
    pub(super) fn available_permits(&self) -> usize {
        self.send.available_permits() + self.watermark.available_permits()
    }

    #[cfg(test)]
    pub(super) fn queued_sends(&self) -> usize {
        self.queued.lock().unwrap().total
    }

    pub(super) fn new(connections: u32) -> Arc<Self> {
        let budget = (connections - connections.div_ceil(5)).min(16) as usize;
        // Separate FIFO budgets reserve half for watermarks while keeping >=20%
        // of the pool outside both workloads. Serving both workloads with that
        // headroom requires >=3 connections: then each budget is at least 1.
        // Pools of 1/2 have 0 watermark slots (and 0/1 send slots); production uses 20.
        Arc::new(Self {
            send: Arc::new(Semaphore::new(budget.div_ceil(2))),
            watermark: Arc::new(Semaphore::new(budget / 2)),
            channels: Default::default(),
            queued: Default::default(),
            #[cfg(test)]
            hold_watermark_timeouts: Default::default(),
            #[cfg(test)]
            watermark_events: Default::default(),
        })
    }

    // Reserve before spawning or registering a work-admission Channel entry.
    pub(super) fn reserve_send(
        self: &Arc<Self>,
        organization: Uuid,
        channel: Uuid,
    ) -> Result<SendWaiter, super::MessageError> {
        let key = (organization, channel);
        let mut queued = lock_ignoring_poison(&self.queued);
        let scope = if queued.total >= GLOBAL_QUEUE_CAP {
            Some(Rejection::SendGlobalQueue)
        } else if queued.channels.get(&key).copied().unwrap_or(0) >= CHANNEL_QUEUE_CAP {
            Some(Rejection::SendChannelQueue)
        } else {
            None
        };
        if let Some(scope) = scope {
            admission(scope);
            return Err(super::MessageError::AdmissionRejected);
        }
        queued.total += 1;
        *queued.channels.entry(key).or_default() += 1;
        Ok(SendWaiter {
            admission: self.clone(),
            key,
        })
    }

    pub(super) async fn acquire(
        self: &Arc<Self>,
        organization: Uuid,
        channel: Uuid,
        send: bool,
    ) -> Result<Permit, sqlx::Error> {
        let key = (organization, channel);
        let slots = lock_ignoring_poison(&self.channels)
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
            admission: self.clone(),
            key,
            slots: Some(slots),
            channel: None,
            global: None,
        };
        // Contract tests retain both FIFO limits without measuring runner speed.
        // This switch belongs to one Admission, shared only by its Delivery clones.
        #[cfg(test)]
        if !send
            && self
                .hold_watermark_timeouts
                .load(std::sync::atomic::Ordering::Relaxed)
        {
            permit.channel = Some(semaphore.acquire_owned().await.unwrap());
            permit.global = Some(self.watermark.clone().acquire_owned().await.unwrap());
            return Ok(permit);
        }
        // Send waiters hold no connection, so absorb ordinary hot-Channel bursts
        // for as long as the pool's former acquire budget allowed.
        let wait = if send {
            SEND_ADMISSION_WAIT
        } else {
            ADMISSION_WAIT
        };
        let deadline = tokio::time::Instant::now() + wait;
        let channel_rejection = if send {
            Rejection::SendChannel
        } else {
            Rejection::WatermarkChannel
        };
        let channel_permit = acquire(&semaphore, deadline, channel_rejection).await;
        #[cfg(test)]
        if !send && channel_permit.is_err() {
            self.record_watermark_event(organization, channel, "channel_rejection");
        }
        permit.channel = Some(channel_permit?);
        let global = if send { &self.send } else { &self.watermark };
        let global_rejection = if send {
            Rejection::SendGlobal
        } else {
            Rejection::WatermarkGlobal
        };
        let global_permit = acquire(global, deadline, global_rejection).await;
        #[cfg(test)]
        if !send && global_permit.is_err() {
            self.record_watermark_event(organization, channel, "global_rejection");
        }
        permit.global = Some(global_permit?);
        Ok(permit)
    }
}

async fn acquire(
    semaphore: &Arc<Semaphore>,
    deadline: tokio::time::Instant,
    rejection: Rejection,
) -> Result<OwnedSemaphorePermit, sqlx::Error> {
    match tokio::time::timeout_at(deadline, semaphore.clone().acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        _ => {
            admission(rejection);
            Err(sqlx::Error::Io(std::io::Error::new(
                std::io::ErrorKind::WouldBlock,
                "message work admission rejected",
            )))
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        drop(self.global.take());
        drop(self.channel.take());
        let mut channels = lock_ignoring_poison(&self.admission.channels);
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

    fn assert_queue_empty(admission: &Admission) {
        let queued = admission.queued.lock().unwrap();
        assert_eq!(queued.total, 0);
        assert!(queued.channels.is_empty());
        assert!(admission.channels.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn held_watermark_timeouts_preserve_caps_and_permit_handoffs() {
        let admission = Admission::new(20);
        admission.hold_watermark_timeouts();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut held = Vec::new();
        for _ in 0..4 {
            held.push(
                admission
                    .acquire(organization, channel, false)
                    .await
                    .unwrap(),
            );
        }
        let waiting = admission.acquire(organization, channel, false);
        tokio::pin!(waiting);
        // Advance virtual time past the real deadline while all Channel slots
        // stay held. Releasing a slot, rather than runner speed, admits the next.
        assert!(
            tokio::time::timeout(ADMISSION_WAIT * 2, &mut waiting)
                .await
                .is_err()
        );
        assert_eq!(admission.watermark.available_permits(), 4);
        drop(held.pop());
        held.push(waiting.await.unwrap());
        for _ in 0..4 {
            held.push(
                admission
                    .acquire(organization, Uuid::new_v4(), false)
                    .await
                    .unwrap(),
            );
        }
        let waiting = admission.acquire(organization, Uuid::new_v4(), false);
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(ADMISSION_WAIT * 2, &mut waiting)
                .await
                .is_err()
        );
        assert_eq!(admission.watermark.available_permits(), 0);
        drop(held.pop());
        drop(waiting.await.unwrap());
        drop(held);
        assert_queue_empty(&admission);
        assert_eq!(admission.available_permits(), 16);
    }

    #[test]
    fn send_queue_caps_are_exact_and_rejections_never_register_channels() {
        let admission = Admission::new(20);
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut queued = Vec::new();
        for _ in 0..CHANNEL_QUEUE_CAP - 1 {
            queued.push(admission.reserve_send(organization, channel).unwrap());
        }
        queued.push(admission.reserve_send(organization, channel).unwrap());
        assert!(matches!(
            admission.reserve_send(organization, channel),
            Err(super::super::MessageError::AdmissionRejected)
        ));
        // Same Channel id in another Organization and another Channel are independent.
        drop(admission.reserve_send(Uuid::new_v4(), channel).unwrap());
        drop(
            admission
                .reserve_send(organization, Uuid::new_v4())
                .unwrap(),
        );
        // One Organization can consume every global slot across its Channels.
        for _ in CHANNEL_QUEUE_CAP..GLOBAL_QUEUE_CAP - 1 {
            queued.push(
                admission
                    .reserve_send(organization, Uuid::new_v4())
                    .unwrap(),
            );
        }
        queued.push(
            admission
                .reserve_send(organization, Uuid::new_v4())
                .unwrap(),
        );
        let keys = admission.queued.lock().unwrap().channels.len();
        assert!(
            admission
                .reserve_send(Uuid::new_v4(), Uuid::new_v4())
                .is_err()
        );
        assert_eq!(admission.queued.lock().unwrap().channels.len(), keys);
        assert!(admission.channels.lock().unwrap().is_empty());
        drop(queued.pop());
        drop(
            admission
                .reserve_send(Uuid::new_v4(), Uuid::new_v4())
                .unwrap(),
        );
        drop(queued);
        assert_queue_empty(&admission);
    }

    #[tokio::test(start_paused = true)]
    async fn send_queue_slots_release_on_admission_completion_and_wait_expiry() {
        let admission = Admission::new(20);
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let held = admission
            .reserve_send(organization, channel)
            .unwrap()
            .acquire()
            .await
            .unwrap();
        assert_eq!(admission.queued.lock().unwrap().total, 0);
        let started = tokio::time::Instant::now();
        assert!(matches!(
            admission
                .reserve_send(organization, channel)
                .unwrap()
                .acquire()
                .await,
            Err(super::super::MessageError::AdmissionRejected)
        ));
        assert_eq!(started.elapsed(), SEND_ADMISSION_WAIT);
        assert_eq!(admission.queued.lock().unwrap().total, 0);
        drop(held);
        assert_queue_empty(&admission);
    }

    #[tokio::test]
    async fn send_queue_slots_release_on_cancellation_and_panic() {
        let admission = Admission::new(20);
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let held = admission
            .reserve_send(organization, channel)
            .unwrap()
            .acquire()
            .await
            .unwrap();
        let waiter = admission.reserve_send(organization, channel).unwrap();
        let task = tokio::spawn(async move { waiter.acquire().await });
        tokio::task::yield_now().await;
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        assert_eq!(admission.queued.lock().unwrap().total, 0);
        let waiter = admission.reserve_send(organization, channel).unwrap();
        let task = tokio::spawn(async move {
            let _waiter = waiter;
            panic!("queue reservation panic regression");
        });
        assert!(task.await.unwrap_err().is_panic());
        assert_eq!(admission.queued.lock().unwrap().total, 0);
        drop(held);
        // An admitted task panic must also release work permits and registry entries.
        let permit = admission
            .reserve_send(organization, channel)
            .unwrap()
            .acquire()
            .await
            .unwrap();
        assert!(
            tokio::spawn(async move {
                let _permit = permit;
                panic!("admitted panic regression");
            })
            .await
            .unwrap_err()
            .is_panic()
        );
        assert_eq!(admission.available_permits(), 16);
        assert_queue_empty(&admission);
    }

    #[tokio::test(start_paused = true)]
    async fn send_admission_has_a_separate_longer_budget_without_holding_global_capacity() {
        let admission = Admission::new(20);
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let held = admission
            .acquire(organization, channel, true)
            .await
            .unwrap();
        let waiting = admission.acquire(organization, channel, true);
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), &mut waiting)
                .await
                .is_err()
        );
        assert_eq!(admission.available_permits(), 15);
        drop(held);
        drop(waiting.await.unwrap());

        let held = admission
            .acquire(organization, channel, true)
            .await
            .unwrap();
        let started = tokio::time::Instant::now();
        assert!(
            admission
                .acquire(organization, channel, true)
                .await
                .is_err()
        );
        assert_eq!(started.elapsed(), SEND_ADMISSION_WAIT);
        drop(held);
        assert_eq!(admission.available_permits(), 16);
        assert!(admission.channels.lock().unwrap().is_empty());
    }

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
    async fn separate_budgets_preserve_pool_headroom_without_queueing_for_a_connection() {
        for (connections, limit) in [
            (1, 0),
            (2, 1),
            (3, 2),
            (4, 3),
            (5, 4),
            (19, 15),
            (20, 16),
            (21, 16),
            (100, 16),
            (u32::MAX, 16),
        ] {
            let admission = Admission::new(connections);
            assert!(connections - limit as u32 >= connections.div_ceil(5));
            if connections >= 3 {
                assert!(admission.watermark.available_permits() >= 1);
            }
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

    #[tokio::test(start_paused = true)]
    async fn send_saturation_cannot_take_reserved_watermark_capacity() {
        let admission = Admission::new(20);
        let organization = Uuid::new_v4();
        let mut sends = Vec::new();
        for _ in 0..8 {
            sends.push(
                admission
                    .acquire(organization, Uuid::new_v4(), true)
                    .await
                    .unwrap(),
            );
        }
        assert!(
            admission
                .acquire(organization, Uuid::new_v4(), true)
                .await
                .is_err()
        );
        let mut watermarks = Vec::new();
        for _ in 0..8 {
            watermarks.push(
                admission
                    .acquire(Uuid::new_v4(), Uuid::new_v4(), false)
                    .await
                    .unwrap(),
            );
        }
        assert_eq!(admission.available_permits(), 0);
        drop((sends, watermarks));
        assert_eq!(admission.available_permits(), 16);
        assert!(admission.channels.lock().unwrap().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_last_exits_remove_idle_channel_entries() {
        let admission = Admission::new(20);
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
