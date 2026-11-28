mod frame;
mod notification;
mod publication;
mod registry;

use super::admission::Admission;
use super::failure::Failures;
use crate::channels;
use notification::{MAX_PENDING_NOTIFICATIONS, OrganizationReservations};
use registry::ChannelRegistry;
use std::sync::{Arc, OnceLock};
#[cfg(test)]
use std::{collections::HashSet, sync::Mutex};
use tokio::sync::Semaphore;
#[cfg(test)]
use uuid::Uuid;

pub(crate) use frame::LiveMessage;
pub(crate) use notification::MAX_IN_FLIGHT_NOTIFICATIONS;
pub(super) use notification::Notification;
#[cfg(test)]
pub(crate) use notification::{MAX_ORGANIZATION_NOTIFICATIONS, NOTIFICATION_TIMEOUT};
#[cfg(test)]
pub(crate) use publication::pause_publication;
pub(crate) use registry::{LIVE_QUEUE_CAPACITY, LiveQueue};

/// Process-local fan-out of canonical committed messages, with one shared payload per send.
/// Use exactly one Delivery and its clones per application pool; admission is sized
/// once from that pool on first use.
#[derive(Clone)]
pub struct Delivery {
    pub channel_access: channels::AccessChanges,
    pub(crate) work: crate::shutdown::Work,
    recipients: ChannelRegistry,
    notifications: Arc<Semaphore>,
    pending_notifications: Arc<Semaphore>,
    organization_notifications: OrganizationReservations,
    admission: Arc<OnceLock<Arc<Admission>>>,
    failures: Failures,
    pub(super) send_limiter: super::limiter::SendLimiter,
    #[cfg(test)]
    pub(crate) live_refills: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    pub(crate) message_serializations: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    #[cfg(test)]
    held_notification_timeouts: Arc<Mutex<HashSet<Uuid>>>,
}

impl Delivery {
    /// Delivery with an operator-configured send limit (`docs/decisions/messages.md`).
    pub fn with_send_limit(limit: super::SendLimit) -> Self {
        Self {
            send_limiter: super::limiter::SendLimiter::new(limit),
            ..Self::default()
        }
    }
}

impl Default for Delivery {
    fn default() -> Self {
        Self {
            channel_access: Default::default(),
            work: Default::default(),
            recipients: Default::default(),
            notifications: Arc::new(Semaphore::new(MAX_IN_FLIGHT_NOTIFICATIONS)),
            pending_notifications: Arc::new(Semaphore::new(MAX_PENDING_NOTIFICATIONS)),
            organization_notifications: Default::default(),
            admission: Default::default(),
            failures: Default::default(),
            send_limiter: Default::default(),
            #[cfg(test)]
            live_refills: Default::default(),
            #[cfg(test)]
            message_serializations: Default::default(),
            #[cfg(test)]
            tasks: Default::default(),
            #[cfg(test)]
            held_notification_timeouts: Default::default(),
        }
    }
}

impl Delivery {
    pub async fn drained(&self) {
        self.work.drained().await;
    }

    #[cfg(test)]
    pub(crate) fn failure_wait_polls(&self, organization: Uuid, channel: Uuid) -> usize {
        self.failures.wait_polls((organization, channel))
    }

    // Exactly one Delivery (and its clones) belongs to one application pool.
    // Lazily size its shared budget from that pool, including in small test pools.
    pub(super) fn admission(&self, pool: &sqlx::PgPool) -> &Arc<Admission> {
        self.admission
            .get_or_init(|| Admission::new(pool.options().get_max_connections()))
    }

    #[cfg(test)]
    pub(crate) fn record_watermark_caller(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        channel: Uuid,
        caller: &'static str,
    ) {
        self.admission(pool)
            .record_watermark_event(organization, channel, caller);
    }

    #[cfg(test)]
    pub(crate) fn take_watermark_events(
        &self,
        pool: &sqlx::PgPool,
    ) -> Vec<(Uuid, Uuid, &'static str)> {
        self.admission(pool).take_watermark_events()
    }

    #[cfg(test)]
    pub(crate) fn hold_watermark_admission_timeouts(&self, pool: &sqlx::PgPool) {
        self.admission(pool).hold_watermark_timeouts();
    }

    #[cfg(test)]
    pub(crate) async fn hold_watermark_permit(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        channel: Uuid,
    ) -> impl Drop {
        self.admission(pool)
            .acquire(organization, channel, false)
            .await
            .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::super::Message;
    use super::notification::MAX_PENDING_NOTIFICATIONS;
    use super::publication::PUBLICATION_GATES;
    use super::registry::MAX_CHANNEL_NOTIFICATIONS;
    use super::*;
    use crate::test_support::Gate;
    use std::time::Duration;

    fn committed_message(channel: Uuid) -> Message {
        Message {
            history_generation: uuid::Uuid::nil(),
            id: Uuid::new_v4(),
            channel_id: channel,
            created_seq: 1,
            version: 1,
            deleted: false,
            client_message_id: Uuid::new_v4(),
            sender: Uuid::new_v4(),
            body: Some("committed".into()),
            created_at: "now".into(),
            topic_id: None,
            reply_to: None,
            reply_root_id: None,
            mentions: Some(Vec::new()),
        }
    }

    #[tokio::test]
    async fn global_notification_reservations_bound_tasks_and_release_on_cancel() {
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        // No task can be polled on this current-thread runtime until we yield.
        for _ in 0..MAX_PENDING_NOTIFICATIONS {
            let message = committed_message(Uuid::new_v4());
            delivery
                .notification(Uuid::new_v4(), message.channel_id, 1)
                .spawn(pool.clone(), message);
        }
        assert_eq!(
            delivery.notification_reservations(),
            (MAX_PENDING_NOTIFICATIONS, MAX_PENDING_NOTIFICATIONS)
        );
        assert_eq!(delivery.pending_notifications.available_permits(), 0);
        assert_eq!(delivery.notification_permits(), MAX_IN_FLIGHT_NOTIFICATIONS);
        let channel = Uuid::new_v4();
        let mut affected = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
        affected.subscribe(channel);
        delivery
            .notification(organization, channel, 1)
            .spawn(pool, committed_message(channel));
        assert!(affected.notification_failed.is_failed());
        assert!(!*affected.overflow.borrow());
        assert_eq!(
            delivery.organization_notifications.lock().unwrap().len(),
            MAX_PENDING_NOTIFICATIONS
        );
        let tasks = std::mem::take(&mut *delivery.tasks.lock().unwrap());
        assert_eq!(tasks.len(), MAX_PENDING_NOTIFICATIONS);
        for task in &tasks {
            task.abort();
        }
        for task in tasks {
            assert!(task.await.unwrap_err().is_cancelled());
        }
        assert_eq!(
            delivery.pending_notifications.available_permits(),
            MAX_PENDING_NOTIFICATIONS
        );
        assert_eq!(delivery.recipients.lock().unwrap().len(), 1);
        assert_eq!(delivery.notification_reservations(), (0, 0));
    }

    #[tokio::test]
    async fn global_notification_execution_saturation_latches_without_leaking_reservations() {
        let delivery = Delivery::default();
        let executing = delivery
            .notifications
            .clone()
            .acquire_many_owned(MAX_IN_FLIGHT_NOTIFICATIONS as u32)
            .await
            .unwrap();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut affected = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
        affected.subscribe(channel);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        delivery
            .notification(organization, channel, 1)
            .spawn(pool, committed_message(channel));
        delivery.flush().await;
        assert!(affected.notification_failed.is_failed());
        assert!(!*affected.overflow.borrow());
        assert!(affected.events.try_recv().is_err());
        assert_eq!(
            delivery.pending_notifications.available_permits(),
            MAX_PENDING_NOTIFICATIONS
        );
        assert_eq!(
            delivery.channel_notification_permits(organization, channel),
            MAX_IN_FLIGHT_NOTIFICATIONS
        );
        drop(executing);
        assert_eq!(delivery.notification_permits(), MAX_IN_FLIGHT_NOTIFICATIONS);
        assert_eq!(delivery.notification_reservations(), (0, 0));
    }

    #[tokio::test(start_paused = true)]
    async fn cursor_wait_cancellation_and_deadline_release_bounded_reservations() {
        for cancel in [true, false] {
            let delivery = Delivery::default();
            let organization = Uuid::new_v4();
            let channel = Uuid::new_v4();
            let mut affected = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
            affected.subscribe(channel);
            let gate = Arc::new(Gate::default());
            let holder = {
                let delivery = delivery.clone();
                let gate = gate.clone();
                tokio::spawn(async move {
                    delivery
                        .hold_publication_cursor(organization, channel, &gate)
                        .await;
                })
            };
            gate.entered().await;
            let pool = sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
                .unwrap();
            delivery
                .notification(organization, channel, 1)
                .spawn(pool, committed_message(channel));
            tokio::task::yield_now().await;
            assert_eq!(delivery.notification_permits(), MAX_IN_FLIGHT_NOTIFICATIONS);
            assert_eq!(
                delivery.pending_notifications.available_permits(),
                MAX_PENDING_NOTIFICATIONS - 1
            );
            assert_eq!(
                delivery.channel_notification_permits(organization, channel),
                MAX_IN_FLIGHT_NOTIFICATIONS - 1
            );
            assert!(!affected.notification_failed.is_failed());
            assert_eq!(delivery.notification_reservations(), (1, 1));
            if cancel {
                let task = delivery.tasks.lock().unwrap().pop().unwrap();
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                tokio::time::advance(NOTIFICATION_TIMEOUT - Duration::from_millis(1)).await;
                assert!(!affected.notification_failed.is_failed());
                tokio::time::advance(Duration::from_millis(1)).await;
                delivery.flush().await;
            }
            assert!(affected.notification_failed.is_failed());
            assert_eq!(delivery.notification_reservations(), (0, 0));
            assert!(!*affected.overflow.borrow());
            assert!(affected.events.try_recv().is_err());
            assert_eq!(
                delivery.pending_notifications.available_permits(),
                MAX_PENDING_NOTIFICATIONS
            );
            assert_eq!(
                delivery.channel_notification_permits(organization, channel),
                MAX_IN_FLIGHT_NOTIFICATIONS
            );
            gate.release();
            holder.await.unwrap();
            drop(affected);
            assert!(delivery.recipients.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn organization_cap_rejection_is_channel_scoped_and_releases_partial_reservations() {
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut affected = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
        affected.subscribe(channel);
        let mut other_channel = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
        other_channel.subscribe(Uuid::new_v4());
        let mut other_organization = delivery.queue(Uuid::new_v4(), (Uuid::new_v4(), 0), 1);
        other_organization.subscribe(channel);
        let slots: Vec<_> = (0..MAX_ORGANIZATION_NOTIFICATIONS)
            .map(|_| {
                let global = delivery
                    .pending_notifications
                    .clone()
                    .try_acquire_owned()
                    .unwrap();
                delivery.reserve_organization(organization, global).unwrap()
            })
            .collect();
        // A cap rejection must not spawn a publication task.
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        delivery
            .notification(organization, channel, 1)
            .spawn(pool, committed_message(channel));
        assert!(affected.notification_failed.is_failed());
        assert!(!other_channel.notification_failed.is_failed());
        assert!(!other_organization.notification_failed.is_failed());
        assert!(!*affected.overflow.borrow());
        assert!(delivery.tasks.lock().unwrap().is_empty());
        assert_eq!(
            delivery.notification_reservations(),
            (MAX_ORGANIZATION_NOTIFICATIONS, 1)
        );
        assert_eq!(
            delivery.channel_notification_permits(organization, channel),
            MAX_CHANNEL_NOTIFICATIONS
        );
        drop(slots);
        assert_eq!(delivery.notification_reservations(), (0, 0));
    }

    #[tokio::test(start_paused = true)]
    async fn organization_cap_snapshot_and_later_send_require_held_notification_timeouts() {
        for hold_timeout in [false, true] {
            let delivery = Delivery::default();
            let organization = Uuid::new_v4();
            delivery.hold_notification_timeouts(organization, hold_timeout);
            let pool = sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
                .unwrap();
            let mut hot = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
            let hot_channel = Uuid::new_v4();
            hot.subscribe(hot_channel);
            let mut cold = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
            let cold_channel = Uuid::new_v4();
            cold.subscribe(cold_channel);
            // Spawn synchronously on a paused current-thread runtime: all reservations
            // exist before any deadline can fire, just as they do before HTTP 201.
            let mut gates = Vec::new();
            for index in 0..MAX_ORGANIZATION_NOTIFICATIONS {
                let channel = if index == 0 {
                    hot_channel
                } else {
                    Uuid::new_v4()
                };
                let message = committed_message(channel);
                gates.push(pause_publication(message.client_message_id));
                delivery
                    .notification(organization, channel, 1)
                    .spawn(pool.clone(), message);
            }
            assert_eq!(
                delivery.notification_reservations(),
                (MAX_ORGANIZATION_NOTIFICATIONS, 1)
            );
            let mut tasks = std::mem::take(&mut *delivery.tasks.lock().unwrap());
            tokio::time::advance(NOTIFICATION_TIMEOUT).await;
            // Every task first polls its blocked publication at/after the deadline.
            // On this current-thread runtime the entered permit cannot be observed
            // until that poll (including the timeout check) has returned.
            for gate in gates {
                gate.entered().await;
            }
            if hold_timeout {
                assert_eq!(
                    delivery.notification_reservations(),
                    (MAX_ORGANIZATION_NOTIFICATIONS, 1)
                );
                assert!(!hot.notification_failed.is_failed());
            } else {
                for task in tasks.drain(..) {
                    // Await actual timeout completion, rather than a racing snapshot.
                    task.await.unwrap();
                }
                assert_eq!(delivery.notification_reservations(), (0, 0));
                assert!(hot.notification_failed.is_failed());
            }
            let message = committed_message(cold_channel);
            let key = message.client_message_id;
            let gate = pause_publication(key);
            delivery
                .notification(organization, cold_channel, 1)
                .spawn(pool.clone(), message);
            if hold_timeout {
                // Cap rejection signals 1011/replay on this Channel too.
                assert!(cold.notification_failed.is_failed());
            } else {
                gate.entered().await;
                // The stale 512 snapshot cannot require a close: this send was
                // admitted, and expired hot Channels cannot fail the cold Channel.
                assert!(!cold.notification_failed.is_failed());
                assert_eq!(delivery.notification_reservations(), (1, 1));
            }
            if let Some(task) = gate.hook_state.abort_handle.lock().unwrap().as_ref() {
                task.abort();
            }
            for task in tasks {
                task.abort();
                let _ = task.await;
            }
            delivery.flush().await;
            PUBLICATION_GATES.take(&key);
            assert_eq!(delivery.notification_reservations(), (0, 0));
        }
    }

    #[test]
    fn organization_reservations_reclaim_concurrent_last_exits_and_replacements() {
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let reserve = || {
            let global = delivery
                .pending_notifications
                .clone()
                .try_acquire_owned()
                .ok()?;
            delivery.reserve_organization(organization, global)
        };
        for _ in 0..64 {
            let first = reserve().unwrap();
            let second = reserve().unwrap();
            let barrier = std::sync::Barrier::new(3);
            let replacement = std::thread::scope(|scope| {
                let first_exit = scope.spawn(|| {
                    barrier.wait();
                    drop(first);
                });
                let second_exit = scope.spawn(|| {
                    barrier.wait();
                    drop(second);
                });
                let acquire = scope.spawn(|| {
                    barrier.wait();
                    reserve().unwrap()
                });
                first_exit.join().unwrap();
                second_exit.join().unwrap();
                acquire.join().unwrap()
            });
            assert_eq!(delivery.notification_reservations(), (1, 1));
            assert_eq!(
                delivery.organization_notifications.lock().unwrap()[&organization],
                1
            );
            let mut slots = vec![replacement];
            for _ in 1..MAX_ORGANIZATION_NOTIFICATIONS {
                slots.push(reserve().unwrap());
            }
            // Removal must not have created a second budget for this Organization.
            assert!(reserve().is_none());
            assert_eq!(
                delivery.notification_reservations(),
                (MAX_ORGANIZATION_NOTIFICATIONS, 1)
            );
            drop(slots);
            assert_eq!(delivery.notification_reservations(), (0, 0));
        }
    }

    #[tokio::test]
    async fn notification_panic_releases_organization_reservation_and_latches_failure() {
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut affected = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
        affected.subscribe(channel);
        let message = committed_message(channel);
        let gate = pause_publication(message.client_message_id);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        delivery
            .notification(organization, channel, 1)
            .spawn(pool, message);
        gate.entered().await;
        assert_eq!(delivery.notification_reservations(), (1, 1));
        // The test-only publication gate unwraps a closed semaphore, unwinding the task.
        gate.close();
        let task = delivery.tasks.lock().unwrap().pop().unwrap();
        assert!(task.await.unwrap_err().is_panic());
        assert!(affected.notification_failed.is_failed());
        assert!(!*affected.overflow.borrow());
        assert_eq!(delivery.notification_reservations(), (0, 0));
        assert_eq!(
            delivery.channel_notification_permits(organization, channel),
            MAX_CHANNEL_NOTIFICATIONS
        );
        assert_eq!(delivery.notification_permits(), MAX_IN_FLIGHT_NOTIFICATIONS);
    }

    #[test]
    fn notification_drop_without_runtime_latches_failure_without_panicking() {
        assert!(tokio::runtime::Handle::try_current().is_err());
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut queue = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
        queue.subscribe(channel);
        drop(delivery.notification(organization, channel, 1));
        assert!(queue.notification_failed.is_failed());
        // A future observer still sees the latch, without needing the skipped wake.
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let mut wait = queue.notification_failed.clone().spawn();
                tokio::time::timeout(Duration::from_secs(1), wait.failed())
                    .await
                    .unwrap();
            });
        drop(queue);
    }

    #[fukulow_test::test]
    async fn watermark_capacity_covers_pool_wait_and_releases_on_every_exit(pool: sqlx::PgPool) {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(3)
            .connect_with((*pool.connect_options()).clone())
            .await
            .unwrap();
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        for cancel in [true, false] {
            let first = pool.acquire().await.unwrap();
            let second = pool.acquire().await.unwrap();
            let third = pool.acquire().await.unwrap();
            let waiting = {
                let pool = pool.clone();
                let delivery = delivery.clone();
                tokio::spawn(async move { delivery.latest_seq(&pool, organization, channel).await })
            };
            tokio::time::timeout(Duration::from_secs(2), async {
                while delivery.admission(&pool).available_permits() != 1 {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            // The cap is shared across clones and Channels, before pool acquisition.
            assert!(matches!(
                delivery
                    .clone()
                    .latest_seq(&pool, organization, Uuid::new_v4())
                    .await,
                Err(crate::database::InternalError::Saturated)
            ));
            if cancel {
                waiting.abort();
                assert!(waiting.await.unwrap_err().is_cancelled());
            } else {
                tokio::time::pause();
                tokio::time::advance(NOTIFICATION_TIMEOUT).await;
                tokio::time::resume();
                assert!(matches!(
                    waiting.await.unwrap(),
                    Err(crate::database::InternalError::Deadline)
                ));
            }
            assert_eq!(delivery.admission(&pool).available_permits(), 2);
            drop((first, second, third));
            assert_eq!(
                delivery
                    .latest_seq(&pool, organization, channel)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(delivery.admission(&pool).available_permits(), 2);
        }
        pool.close().await;
        assert!(matches!(
            delivery.latest_seq(&pool, organization, channel).await,
            Err(crate::database::InternalError::Db(sqlx::Error::PoolClosed))
        ));
        assert_eq!(delivery.admission(&pool).available_permits(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn notification_timeout_signals_and_releases_capacity() {
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut affected = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
        affected.subscribe(channel);
        let key = Uuid::new_v4();
        let gate = pause_publication(key);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        delivery.notification(organization, channel, 1).spawn(
            pool,
            Message {
                history_generation: uuid::Uuid::nil(),
                id: Uuid::new_v4(),
                channel_id: channel,
                created_seq: 1,
                version: 1,
                deleted: false,
                client_message_id: key,
                sender: Uuid::new_v4(),
                body: Some("committed".into()),
                created_at: "now".into(),
                topic_id: None,
                reply_to: None,
                reply_root_id: None,
                mentions: Some(Vec::new()),
            },
        );
        gate.entered().await;
        assert_eq!(
            delivery.notifications.available_permits(),
            MAX_IN_FLIGHT_NOTIFICATIONS
        );
        assert_eq!(
            delivery.pending_notifications.available_permits(),
            MAX_PENDING_NOTIFICATIONS - 1
        );
        assert_eq!(
            delivery.channel_notification_permits(organization, channel),
            MAX_IN_FLIGHT_NOTIFICATIONS - 1
        );
        tokio::time::advance(NOTIFICATION_TIMEOUT - Duration::from_millis(1)).await;
        assert!(!affected.notification_failed.is_failed());
        tokio::time::advance(Duration::from_millis(1)).await;
        delivery.flush().await;
        assert!(affected.notification_failed.is_failed());
        assert!(!*affected.overflow.borrow());
        assert!(affected.events.try_recv().is_err());
        assert_eq!(
            delivery.notifications.available_permits(),
            MAX_IN_FLIGHT_NOTIFICATIONS
        );
        assert_eq!(
            delivery.pending_notifications.available_permits(),
            MAX_PENDING_NOTIFICATIONS
        );
        assert_eq!(
            delivery.channel_notification_permits(organization, channel),
            MAX_IN_FLIGHT_NOTIFICATIONS
        );
        assert_eq!(delivery.notification_reservations(), (0, 0));
    }

    #[tokio::test]
    async fn notification_cancelled_before_first_poll_signals_only_its_organization_channel() {
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut affected = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
        affected.subscribe(channel);
        let mut other_channel = delivery.queue(organization, (Uuid::new_v4(), 0), 1);
        other_channel.subscribe(Uuid::new_v4());
        let mut other_org = delivery.queue(Uuid::new_v4(), (Uuid::new_v4(), 0), 1);
        other_org.subscribe(channel);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        delivery.notification(organization, channel, 1).spawn(
            pool,
            Message {
                history_generation: uuid::Uuid::nil(),
                id: Uuid::new_v4(),
                channel_id: channel,
                created_seq: 1,
                version: 1,
                deleted: false,
                client_message_id: Uuid::new_v4(),
                sender: Uuid::new_v4(),
                body: Some("committed".into()),
                created_at: "now".into(),
                topic_id: None,
                reply_to: None,
                reply_root_id: None,
                mentions: Some(Vec::new()),
            },
        );
        // The current-thread runtime cannot poll the spawned future until we yield.
        let task = delivery.tasks.lock().unwrap().pop().unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(affected.notification_failed.is_failed());
        assert!(!*affected.overflow.borrow());
        assert!(!other_channel.notification_failed.is_failed());
        assert!(!other_org.notification_failed.is_failed());
        assert!(affected.events.try_recv().is_err());
        assert_eq!(
            delivery.pending_notifications.available_permits(),
            MAX_PENDING_NOTIFICATIONS
        );
        assert_eq!(
            delivery.channel_notification_permits(organization, channel),
            MAX_IN_FLIGHT_NOTIFICATIONS
        );
    }

    #[tokio::test]
    async fn connection_queue_is_bounded_and_drop_removes_registrations() {
        let delivery = Delivery::default();
        let mut queue = delivery.queue(Uuid::new_v4(), (Uuid::new_v4(), 0), 1);
        let channel = Uuid::new_v4();
        queue.subscribe(channel);
        let message = Arc::new(LiveMessage::new(committed_message(channel)).unwrap());
        queue.sender.send(message.clone());
        queue.sender.send(message);
        assert!(*queue.overflow.borrow());
        assert_eq!(queue.events.recv().await.unwrap().seq, 1);
        drop(queue);
        assert!(delivery.recipients.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn channel_registry_retains_notifications_and_cleans_concurrent_last_exits() {
        let delivery = Delivery::default();
        let key = (Uuid::new_v4(), Uuid::new_v4());
        for _ in 0..64 {
            let mut queue = delivery.queue(key.0, (Uuid::new_v4(), 0), 1);
            queue.subscribe(key.1);
            let mut notification = delivery.notification(key.0, key.1, 1);
            notification.complete();
            let fanout = notification.channel.fanout.clone();
            drop(queue);
            assert_eq!(delivery.recipients.lock().unwrap().len(), 1);
            let mut replacement = delivery.queue(key.0, (Uuid::new_v4(), 0), 1);
            replacement.subscribe(key.1);
            assert!(Arc::ptr_eq(&replacement.channels[&key.1].fanout, &fanout));
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    barrier.wait();
                    drop(replacement);
                });
                scope.spawn(|| {
                    barrier.wait();
                    drop(notification);
                });
            });
            assert!(delivery.recipients.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn holding_one_channels_recipients_does_not_lock_the_registry_or_another_channel() {
        let delivery = Delivery::default();
        let org = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut queue = delivery.queue(org, (Uuid::new_v4(), 0), 1);
        queue.subscribe(channel);
        let fanout = queue.channels[&channel].fanout.clone();
        let locked = fanout.recipients.lock().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let mut notification = delivery.notification(org, channel, 1);
                notification.complete();
                let mut other = delivery.queue(org, (Uuid::new_v4(), 0), 1);
                other.subscribe(Uuid::new_v4());
                drop(other);
                drop(notification);
                sender.send(()).unwrap();
            });
            let result = receiver.recv_timeout(Duration::from_secs(2));
            drop(locked);
            result.unwrap();
        });
    }
}
