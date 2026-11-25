use super::super::failure::FailureWatch;
use super::{Delivery, LiveMessage};
use crate::lock_ignoring_poison;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tokio::sync::{Semaphore, mpsc, watch};
use uuid::Uuid;

pub(super) type ChannelKey = (Uuid, Uuid);
type Recipients = HashMap<Uuid, Sender>;
pub(super) type ChannelRegistry = Arc<Mutex<HashMap<ChannelKey, (usize, Arc<ChannelFanout>)>>>;

pub(super) struct ChannelLease {
    registry: ChannelRegistry,
    key: ChannelKey,
    pub(super) fanout: Arc<ChannelFanout>,
}

impl Drop for ChannelLease {
    fn drop(&mut self) {
        let mut registry = lock_ignoring_poison(&self.registry);
        if let Some((leases, _)) = registry.get_mut(&self.key) {
            *leases -= 1;
            if *leases == 0 {
                registry.remove(&self.key);
            }
        }
    }
}

pub(super) struct ChannelFanout {
    pub(super) recipients: Mutex<Recipients>,
    // Initialized before COMMIT while sends still serialize on the Channel barrier.
    // A new subscriber replays history; it need not seed this publication cursor.
    pub(super) first_seq: OnceLock<i64>,
    pub(super) published: tokio::sync::Mutex<Option<i64>>,
    pub(super) notifications: Arc<Semaphore>,
}

impl Default for ChannelFanout {
    fn default() -> Self {
        Self {
            recipients: Default::default(),
            first_seq: Default::default(),
            published: Default::default(),
            notifications: Arc::new(Semaphore::new(MAX_CHANNEL_NOTIFICATIONS)),
        }
    }
}

pub(super) const MAX_CHANNEL_NOTIFICATIONS: usize = 40;
pub(crate) const LIVE_QUEUE_CAPACITY: usize = 256;

#[derive(Clone)]
pub(super) struct Sender {
    pub(super) member: (Uuid, i64),
    events: mpsc::Sender<Arc<LiveMessage>>,
    pub(super) overflow: watch::Sender<bool>,
}
impl Sender {
    pub(super) fn send(&self, message: Arc<LiveMessage>) {
        if self.events.try_send(message).is_err() {
            self.overflow.send_replace(true);
        }
    }
}

pub(crate) struct LiveQueue {
    delivery: Delivery,
    id: Uuid,
    organization: Uuid,
    pub(super) sender: Sender,
    pub(super) channels: HashMap<Uuid, ChannelLease>,
    pub events: mpsc::Receiver<Arc<LiveMessage>>,
    pub overflow: watch::Receiver<bool>,
    pub notification_failed: FailureWatch,
}

impl Delivery {
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

    pub(super) fn channel(&self, key: ChannelKey) -> ChannelLease {
        let mut registry = lock_ignoring_poison(&self.recipients);
        let (leases, fanout) = registry.entry(key).or_default();
        *leases += 1;
        ChannelLease {
            registry: self.recipients.clone(),
            key,
            fanout: fanout.clone(),
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
}

impl LiveQueue {
    pub(crate) fn subscribe(&mut self, channel: Uuid) {
        if !self.channels.contains_key(&channel) {
            self.delivery
                .failures
                .subscribe((self.organization, channel), &self.notification_failed);
            let fanout = self.delivery.channel((self.organization, channel));
            lock_ignoring_poison(&fanout.fanout.recipients).insert(self.id, self.sender.clone());
            self.channels.insert(channel, fanout);
        }
    }
    pub(crate) fn unsubscribe(&mut self, channel: Uuid) {
        self.delivery
            .failures
            .unsubscribe((self.organization, channel), &self.notification_failed);
        if let Some(fanout) = self.channels.remove(&channel) {
            lock_ignoring_poison(&fanout.fanout.recipients).remove(&self.id);
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
