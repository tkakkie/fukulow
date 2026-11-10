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

// Twice the production pool's 20 connections; bound backlog without waiting on sends.
pub(crate) const MAX_IN_FLIGHT_NOTIFICATIONS: usize = 40;
pub(crate) const NOTIFICATION_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
struct Sender {
    member: Uuid,
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
    recipients: Arc<Mutex<HashMap<ChannelKey, Recipients>>>,
    notifications: Arc<Semaphore>,
    admission: Arc<OnceLock<Admission>>,
    failures: Failures,
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
            tasks: Default::default(),
        }
    }
}

pub(super) struct Notification {
    delivery: Delivery,
    key: ChannelKey,
    completed: bool,
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
                self.delivery.publish(&pool, self.key.0, &message),
            )
            .await
            .is_ok();
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
    channels: Vec<Uuid>,
    pub events: mpsc::Receiver<Arc<Message>>,
    pub overflow: watch::Receiver<bool>,
    pub notification_failed: FailureWatch,
}

impl Delivery {
    // Exactly one Delivery (and its clones) belongs to one application pool.
    // Lazily size its shared budget from that pool, including in small test pools.
    pub(super) fn admission(&self, pool: &sqlx::PgPool) -> &Admission {
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
            super::latest_seq(pool, organization, channel).await
        })
        .await
        .map_err(|_| {
            eprintln!("work_deadline_expired operation=watermark organization={organization} channel={channel}");
            sqlx::Error::Io(std::io::ErrorKind::TimedOut.into())
        })?
    }

    pub(crate) fn queue(&self, organization: Uuid, member: Uuid, capacity: usize) -> LiveQueue {
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
            channels: Vec::new(),
            events: receiver,
            overflow: closed,
            notification_failed: Default::default(),
        }
    }

    pub(super) fn notification(&self, organization: Uuid, channel: Uuid) -> Notification {
        Notification {
            delivery: self.clone(),
            key: (organization, channel),
            completed: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_recipients_locked(&self, run: impl FnOnce()) {
        let _registry = self.recipients.lock().unwrap();
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

    async fn publish(&self, pool: &sqlx::PgPool, organization: Uuid, message: &Message) {
        #[cfg(test)]
        publication_gate(message.client_message_id).await;
        let recipients = self
            .recipients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&(organization, message.channel_id))
            .cloned()
            .unwrap_or_default();
        if recipients.is_empty() {
            return;
        }
        let members: Vec<_> = recipients
            .values()
            .map(|s| s.member)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        let allowed =
            channels::visible_members(pool, organization, message.channel_id, &members).await;
        let Ok(allowed) = allowed else {
            // No protected delivery on a failed authorization query. Reconnect and replay.
            for sender in recipients.values() {
                sender.overflow.send_replace(true);
            }
            return;
        };
        let allowed: HashSet<_> = allowed.into_iter().collect();
        let message = Arc::new(message.clone());
        for sender in recipients.values().filter(|s| allowed.contains(&s.member)) {
            sender.send(message.clone());
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
        if !self.channels.contains(&channel) {
            self.delivery
                .failures
                .subscribe((self.organization, channel), &self.notification_failed);
            self.delivery
                .recipients
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry((self.organization, channel))
                .or_default()
                .insert(self.id, self.sender.clone());
            self.channels.push(channel);
        }
    }
    pub(crate) fn unsubscribe(&mut self, channel: Uuid) {
        self.delivery
            .failures
            .unsubscribe((self.organization, channel), &self.notification_failed);
        let mut registry = self
            .delivery
            .recipients
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let key = (self.organization, channel);
        if let Some(recipients) = registry.get_mut(&key) {
            recipients.remove(&self.id);
            if recipients.is_empty() {
                registry.remove(&key);
            }
        }
        self.channels.retain(|id| *id != channel);
    }
}
impl Drop for LiveQueue {
    fn drop(&mut self) {
        while let Some(channel) = self.channels.last().copied() {
            self.unsubscribe(channel);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test]
    async fn watermark_capacity_covers_pool_wait_and_releases_on_every_exit(pool: sqlx::PgPool) {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(2)
            .connect_with((*pool.connect_options()).clone())
            .await
            .unwrap();
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        for cancel in [true, false] {
            let first = pool.acquire().await.unwrap();
            let second = pool.acquire().await.unwrap();
            let waiting = {
                let pool = pool.clone();
                let delivery = delivery.clone();
                tokio::spawn(async move { delivery.latest_seq(&pool, organization, channel).await })
            };
            tokio::time::timeout(Duration::from_secs(2), async {
                while delivery.admission(&pool).available_permits() != 0 {
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
            assert_eq!(delivery.admission(&pool).available_permits(), 1);
            drop((first, second));
            assert_eq!(
                delivery
                    .latest_seq(&pool, organization, channel)
                    .await
                    .unwrap(),
                0
            );
            assert_eq!(delivery.admission(&pool).available_permits(), 1);
        }
        pool.close().await;
        assert!(matches!(
            delivery.latest_seq(&pool, organization, channel).await,
            Err(sqlx::Error::PoolClosed)
        ));
        assert_eq!(delivery.admission(&pool).available_permits(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn notification_timeout_signals_and_releases_capacity() {
        let delivery = Delivery::default();
        let organization = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let mut affected = delivery.queue(organization, Uuid::new_v4(), 1);
        affected.subscribe(channel);
        let key = Uuid::new_v4();
        let gate = pause_publication(key);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        delivery.notification(organization, channel).spawn(
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
        let mut affected = delivery.queue(organization, Uuid::new_v4(), 1);
        affected.subscribe(channel);
        let mut other_channel = delivery.queue(organization, Uuid::new_v4(), 1);
        other_channel.subscribe(Uuid::new_v4());
        let mut other_org = delivery.queue(Uuid::new_v4(), Uuid::new_v4(), 1);
        other_org.subscribe(channel);
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        delivery.notification(organization, channel).spawn(
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
        let mut queue = delivery.queue(Uuid::new_v4(), Uuid::new_v4(), 1);
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
