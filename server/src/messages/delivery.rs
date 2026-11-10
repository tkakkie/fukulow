use super::Message;
use super::admission::{Admission, WORK_TIMEOUT};
use super::failure::{FailureWatch, Failures};
use crate::channels;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc, watch};
use uuid::Uuid;

type ChannelKey = (Uuid, Uuid);
type Recipients = HashMap<Uuid, Sender>;
type ChannelRegistry = Arc<Mutex<HashMap<ChannelKey, (usize, Arc<ChannelFanout>)>>>;

struct ChannelLease {
    registry: ChannelRegistry,
    key: ChannelKey,
    fanout: Arc<ChannelFanout>,
}

impl Drop for ChannelLease {
    fn drop(&mut self) {
        let mut registry = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((leases, _)) = registry.get_mut(&self.key) {
            *leases -= 1;
            if *leases == 0 {
                registry.remove(&self.key);
            }
        }
    }
}

#[derive(Default)]
struct ChannelFanout {
    recipients: Mutex<Recipients>,
    // Initialized before COMMIT while sends still serialize on the Channel barrier.
    // A new subscriber replays history; it need not seed this publication cursor.
    first_seq: OnceLock<i64>,
    published: tokio::sync::Mutex<Option<i64>>,
}

// Twice the production pool's 20 connections; bound backlog without waiting on sends.
pub(crate) const MAX_IN_FLIGHT_NOTIFICATIONS: usize = 40;
pub(crate) const NOTIFICATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct Sender {
    member: (Uuid, i64),
    events: mpsc::Sender<Arc<Message>>,
    overflow: watch::Sender<bool>,
}
impl Sender {
    fn send(&self, message: Arc<Message>) {
        if self.events.try_send(message).is_err() {
            self.overflow.send_replace(true);
        }
    }
}

/// Process-local fan-out of canonical committed messages, with one shared payload per send.
/// Use exactly one Delivery and its clones per application pool; admission is sized
/// once from that pool on first use.
#[derive(Clone)]
pub struct Delivery {
    recipients: ChannelRegistry,
    notifications: Arc<Semaphore>,
    admission: Arc<OnceLock<Arc<Admission>>>,
    failures: Failures,
    #[cfg(test)]
    pub(crate) live_refills: Arc<std::sync::atomic::AtomicUsize>,
    #[cfg(test)]
    tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

impl Default for Delivery {
    fn default() -> Self {
        Self {
            recipients: Default::default(),
            notifications: Arc::new(Semaphore::new(MAX_IN_FLIGHT_NOTIFICATIONS)),
            admission: Default::default(),
            failures: Default::default(),
            #[cfg(test)]
            live_refills: Default::default(),
            #[cfg(test)]
            tasks: Default::default(),
        }
    }
}

pub(super) struct Notification {
    delivery: Delivery,
    key: ChannelKey,
    completed: bool,
    channel: ChannelLease,
}

impl Notification {
    pub(super) fn complete(&mut self) {
        self.completed = true;
    }

    pub(super) fn spawn(mut self, pool: sqlx::PgPool, message: Message) {
        let Ok(permit) = self.delivery.notifications.clone().try_acquire_owned() else {
            // The message is committed: signal reconnect/replay instead of queuing work.
            return;
        };
        let deadline = tokio::time::Instant::now() + NOTIFICATION_TIMEOUT;
        #[cfg(test)]
        let delivery = self.delivery.clone();
        #[cfg(test)]
        let gate = PUBLICATION_GATES
            .lock()
            .unwrap()
            .get(&message.client_message_id)
            .cloned();
        let task = tokio::spawn(async move {
            let _permit = permit;
            self.completed = tokio::time::timeout_at(
                deadline,
                self.delivery
                    .publish(&pool, self.key.0, &message, &self.channel.fanout),
            )
            .await
            .is_ok_and(|result| result.is_ok());
            drop(self);
        });
        #[cfg(test)]
        {
            if let Some(gate) = gate {
                *gate.task.lock().unwrap() = Some(task.abort_handle());
            }
            delivery.tasks.lock().unwrap().push(task);
        }
        #[cfg(not(test))]
        drop(task);
    }
}

impl Drop for Notification {
    fn drop(&mut self) {
        if !self.completed {
            self.delivery.failures.signal(self.key);
        }
    }
}

pub(crate) struct LiveQueue {
    delivery: Delivery,
    id: Uuid,
    organization: Uuid,
    sender: Sender,
    channels: HashMap<Uuid, ChannelLease>,
    pub events: mpsc::Receiver<Arc<Message>>,
    pub overflow: watch::Receiver<bool>,
    pub notification_failed: FailureWatch,
}

impl Delivery {
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

    pub(crate) async fn latest_seq(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        channel: Uuid,
    ) -> Result<i64, sqlx::Error> {
        tokio::time::timeout(WORK_TIMEOUT, async {
            let _permit = self
                .admission(pool)
                .acquire(organization, channel, false)
                .await?;
            super::latest_seq(pool, organization, channel, _permit).await
        })
        .await
        .map_err(|_| {
            eprintln!("work_deadline_expired operation=watermark organization={organization} channel={channel}");
            sqlx::Error::Io(std::io::ErrorKind::TimedOut.into())
        })?
    }

    pub(crate) fn queue(
        &self,
        organization: Uuid,
        member: (Uuid, i64),
        capacity: usize,
    ) -> LiveQueue {
        let (events, receiver) = mpsc::channel(capacity);
        let (overflow, closed) = watch::channel(false);
        LiveQueue {
            delivery: self.clone(),
            id: Uuid::new_v4(),
            organization,
            sender: Sender {
                member,
                events,
                overflow,
            },
            channels: HashMap::new(),
            events: receiver,
            overflow: closed,
            notification_failed: Default::default(),
        }
    }

    fn channel(&self, key: ChannelKey) -> ChannelLease {
        let mut registry = self.recipients.lock().unwrap_or_else(|e| e.into_inner());
        let (leases, fanout) = registry.entry(key).or_default();
        *leases += 1;
        ChannelLease {
            registry: self.recipients.clone(),
            key,
            fanout: fanout.clone(),
        }
    }

    pub(super) fn notification(&self, organization: Uuid, channel: Uuid, seq: i64) -> Notification {
        let fanout = self.channel((organization, channel));
        fanout.fanout.first_seq.get_or_init(|| seq);
        Notification {
            delivery: self.clone(),
            key: (organization, channel),
            completed: false,
            channel: fanout,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_recipients_locked(&self, run: impl FnOnce()) {
        let channels: Vec<_> = self
            .recipients
            .lock()
            .unwrap()
            .values()
            .map(|(_, channel)| channel.clone())
            .collect();
        let _recipients: Vec<_> = channels
            .iter()
            .map(|channel| channel.recipients.lock().unwrap())
            .collect();
        run();
    }

    #[cfg(test)]
    pub(crate) async fn flush(&self) {
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        for task in tasks {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), task)
                .await
                .unwrap();
        }
    }

    async fn publish(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        message: &Message,
        channel: &ChannelFanout,
    ) -> Result<(), sqlx::Error> {
        #[cfg(test)]
        publication_gate(message.client_message_id).await;
        let mut cursor = channel.published.lock().await;
        let after = cursor
            .get_or_insert_with(|| channel.first_seq.get().copied().unwrap_or(message.seq) - 1);
        if message.seq <= *after {
            return Ok(());
        }
        // Recover a committed gap once per Channel, never once per subscriber.
        // Each bounded page rechecks current Member revisions and private grants.
        while *after < message.seq - 1 {
            let page = super::replay_page(
                pool,
                organization,
                message.channel_id,
                *after,
                message.seq - 1,
            )
            .await?;
            if page.is_empty() {
                return Err(sqlx::Error::RowNotFound);
            }
            let last = page
                .last()
                .map(|message| message.seq)
                .ok_or(sqlx::Error::RowNotFound)?;
            self.fan_out(pool, organization, channel, &page).await;
            *after = last;
        }
        self.fan_out(pool, organization, channel, std::slice::from_ref(message))
            .await;
        *after = message.seq;
        Ok(())
    }

    async fn fan_out(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        channel: &ChannelFanout,
        messages: &[Message],
    ) {
        // Only this Channel's lock covers the O(subscribers) snapshot.
        let recipients: Vec<_> = channel
            .recipients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        if recipients.is_empty() {
            return;
        }
        let members: Vec<_> = recipients
            .iter()
            .map(|s| s.member)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let allowed =
            channels::visible_members(pool, organization, messages[0].channel_id, &members).await;
        let Ok(allowed) = allowed else {
            // No protected delivery on a failed authorization query. Reconnect and replay.
            for sender in &recipients {
                sender.overflow.send_replace(true);
            }
            return;
        };
        let allowed: HashSet<_> = allowed.into_iter().collect();
        let recipients: Vec<_> = recipients
            .iter()
            .filter(|s| allowed.contains(&s.member))
            .collect();
        for message in messages {
            let message = Arc::new(message.clone());
            for sender in &recipients {
                sender.send(message.clone());
            }
        }
    }
}

#[cfg(test)]
static PUBLICATION_GATES: std::sync::LazyLock<Mutex<HashMap<Uuid, Arc<PublicationGate>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
pub(crate) struct PublicationGate {
    pub entered: tokio::sync::Semaphore,
    pub release: tokio::sync::Semaphore,
    pub task: Mutex<Option<tokio::task::AbortHandle>>,
}

#[cfg(test)]
pub(crate) fn pause_publication(key: Uuid) -> Arc<PublicationGate> {
    let gate = Arc::new(PublicationGate {
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
        task: Mutex::new(None),
    });
    PUBLICATION_GATES.lock().unwrap().insert(key, gate.clone());
    gate
}

#[cfg(test)]
async fn publication_gate(key: Uuid) {
    let gate = PUBLICATION_GATES.lock().unwrap().remove(&key);
    if let Some(gate) = gate {
        gate.entered.add_permits(1);
        gate.release.acquire().await.unwrap().forget();
    }
}

impl LiveQueue {
    pub(crate) fn subscribe(&mut self, channel: Uuid) {
        if !self.channels.contains_key(&channel) {
            self.delivery
                .failures
                .subscribe((self.organization, channel), &self.notification_failed);
            let fanout = self.delivery.channel((self.organization, channel));
            fanout
                .fanout
                .recipients
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(self.id, self.sender.clone());
            self.channels.insert(channel, fanout);
        }
    }
    pub(crate) fn unsubscribe(&mut self, channel: Uuid) {
        self.delivery
            .failures
            .unsubscribe((self.organization, channel), &self.notification_failed);
        if let Some(fanout) = self.channels.remove(&channel) {
            fanout
                .fanout
                .recipients
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.id);
        }
    }
}
impl Drop for LiveQueue {
    fn drop(&mut self) {
        while let Some(channel) = self.channels.keys().next().copied() {
            self.unsubscribe(channel);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[sqlx::test]
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
                Err(sqlx::Error::Io(error)) if error.kind() == std::io::ErrorKind::WouldBlock
            ));
            if cancel {
                waiting.abort();
                assert!(waiting.await.unwrap_err().is_cancelled());
            } else {
                tokio::time::pause();
                tokio::time::advance(NOTIFICATION_TIMEOUT).await;
                tokio::time::resume();
                assert!(matches!(waiting.await.unwrap(), Err(sqlx::Error::Io(_))));
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
            Err(sqlx::Error::PoolClosed)
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
                id: Uuid::new_v4(),
                channel_id: channel,
                seq: 1,
                client_message_id: key,
                sender: Uuid::new_v4(),
                body: "committed".into(),
                created_at: "now".into(),
                topic_id: (),
            },
        );
        gate.entered.acquire().await.unwrap().forget();
        assert_eq!(
            delivery.notifications.available_permits(),
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
                id: Uuid::new_v4(),
                channel_id: channel,
                seq: 1,
                client_message_id: Uuid::new_v4(),
                sender: Uuid::new_v4(),
                body: "committed".into(),
                created_at: "now".into(),
                topic_id: (),
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
    }

    #[tokio::test]
    async fn connection_queue_is_bounded_and_drop_removes_registrations() {
        let delivery = Delivery::default();
        let mut queue = delivery.queue(Uuid::new_v4(), (Uuid::new_v4(), 0), 1);
        let channel = Uuid::new_v4();
        queue.subscribe(channel);
        let message = Arc::new(Message {
            id: Uuid::new_v4(),
            channel_id: channel,
            seq: 1,
            client_message_id: Uuid::new_v4(),
            sender: Uuid::new_v4(),
            body: "hello".into(),
            created_at: "now".into(),
            topic_id: (),
        });
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
