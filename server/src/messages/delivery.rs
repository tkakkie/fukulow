use super::Message;
use crate::channels;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

type ChannelKey = (Uuid, Uuid);
type Recipients = HashMap<Uuid, Sender>;

#[derive(Clone)]
struct Sender {
    member: Uuid,
    events: mpsc::Sender<Arc<Message>>,
    overflow: watch::Sender<bool>,
    notification_failed: watch::Sender<bool>,
}
impl Sender {
    fn send(&self, message: Arc<Message>) {
        if self.events.try_send(message).is_err() {
            self.overflow.send_replace(true);
        }
    }
}

/// Process-local fan-out of canonical committed messages, with one shared payload per send.
#[derive(Clone, Default)]
pub struct Delivery {
    recipients: Arc<Mutex<HashMap<ChannelKey, Recipients>>>,
    #[cfg(test)]
    tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
}

pub(super) struct Notification {
    delivery: Delivery,
    key: ChannelKey,
    completed: bool,
}

impl Notification {
    pub(super) fn spawn(mut self, pool: sqlx::PgPool, message: Message) {
        #[cfg(test)]
        let delivery = self.delivery.clone();
        #[cfg(test)]
        let gate = PUBLICATION_GATES
            .lock()
            .unwrap()
            .get(&message.client_message_id)
            .cloned();
        let task = tokio::spawn(async move {
            self.delivery.publish(&pool, self.key.0, &message).await;
            self.completed = true;
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
            let registry = self
                .delivery
                .recipients
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(recipients) = registry.get(&self.key) {
                for sender in recipients.values() {
                    sender.notification_failed.send_replace(true);
                }
            }
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
    pub notification_failed: watch::Receiver<bool>,
}

impl Delivery {
    pub(crate) fn queue(&self, organization: Uuid, member: Uuid, capacity: usize) -> LiveQueue {
        let (events, receiver) = mpsc::channel(capacity);
        let (overflow, closed) = watch::channel(false);
        let (notification_failed, failed) = watch::channel(false);
        LiveQueue {
            delivery: self.clone(),
            id: Uuid::new_v4(),
            organization,
            sender: Sender {
                member,
                events,
                overflow,
                notification_failed,
            },
            channels: Vec::new(),
            events: receiver,
            overflow: closed,
            notification_failed: failed,
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
        assert!(*affected.notification_failed.borrow());
        assert!(!*affected.overflow.borrow());
        assert!(!*other_channel.notification_failed.borrow());
        assert!(!*other_org.notification_failed.borrow());
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
