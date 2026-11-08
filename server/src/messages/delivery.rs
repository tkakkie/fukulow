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
pub struct Delivery(Arc<Mutex<HashMap<ChannelKey, Recipients>>>);

pub(crate) struct LiveQueue {
    delivery: Delivery,
    id: Uuid,
    organization: Uuid,
    sender: Sender,
    channels: Vec<Uuid>,
    pub events: mpsc::Receiver<Arc<Message>>,
    pub overflow: watch::Receiver<bool>,
}

impl Delivery {
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
        }
    }

    pub(super) async fn publish(&self, pool: &sqlx::PgPool, organization: Uuid, message: &Message) {
        #[cfg(test)]
        publication_gate(message.client_message_id).await;
        let recipients = self
            .0
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
}

#[cfg(test)]
pub(crate) fn pause_publication(key: Uuid) -> Arc<PublicationGate> {
    let gate = Arc::new(PublicationGate {
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
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
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry((self.organization, channel))
                .or_default()
                .insert(self.id, self.sender.clone());
            self.channels.push(channel);
        }
    }
    pub(crate) fn unsubscribe(&mut self, channel: Uuid) {
        let mut registry = self.delivery.0.lock().unwrap_or_else(|e| e.into_inner());
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
        assert!(delivery.0.lock().unwrap().is_empty());
    }
}
