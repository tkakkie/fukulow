use super::super::ChannelEvent;
#[cfg(test)]
use super::super::log;
use super::super::{MessageError, commit};
#[cfg(test)]
use super::publication::PUBLICATION_GATES;
use super::{
    Delivery,
    registry::{ChannelKey, ChannelLease},
};
use crate::lock_ignoring_poison;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

pub(super) type OrganizationReservations = Arc<Mutex<HashMap<Uuid, usize>>>;

pub(super) struct OrganizationReservation {
    registry: OrganizationReservations,
    organization: Uuid,
    // Keep global capacity until Drop has removed the Organization's count.
    _global: tokio::sync::OwnedSemaphorePermit,
}

impl Drop for OrganizationReservation {
    fn drop(&mut self) {
        let mut registry = lock_ignoring_poison(&self.registry);
        if let Some(count) = registry.get_mut(&self.organization) {
            *count -= 1;
            if *count == 0 {
                registry.remove(&self.organization);
            }
        }
    }
}

// Execution is twice the production pool's 20 connections. Cursor waiters reserve
// separate capacity before spawning, bounded per Channel, Organization and Delivery.
pub(crate) const MAX_IN_FLIGHT_NOTIFICATIONS: usize = 40;
pub(super) const MAX_PENDING_NOTIFICATIONS: usize = 2048;
pub(crate) const MAX_ORGANIZATION_NOTIFICATIONS: usize = 512;
pub(crate) const NOTIFICATION_TIMEOUT: Duration = Duration::from_secs(10);

pub(in crate::messages) struct Notification {
    delivery: Delivery,
    key: ChannelKey,
    completed: bool,
    pub(super) channel: ChannelLease,
}

impl Notification {
    pub(in crate::messages) fn complete(&mut self) {
        self.completed = true;
    }

    pub(in crate::messages) fn spawn(mut self, pool: sqlx::PgPool, event: impl Into<ChannelEvent>) {
        let event = event.into();
        let Ok(channel_slot) = self
            .channel
            .fanout
            .notifications
            .clone()
            .try_acquire_owned()
        else {
            // This Channel already has its bounded set of waiters; signal reconnect/replay.
            crate::observability::admission(crate::observability::Admission::NotificationChannel);
            return;
        };
        let Ok(pending_slot) = self
            .delivery
            .pending_notifications
            .clone()
            .try_acquire_owned()
        else {
            // The message is committed: signal reconnect/replay instead of queuing work.
            crate::observability::admission(crate::observability::Admission::NotificationGlobal);
            return;
        };
        // Global capacity is taken first so the per-Organization map stays bounded by it;
        // a rejected attempt holds one global permit only until this call returns.
        let Some(organization_slot) = self.delivery.reserve_organization(self.key.0, pending_slot)
        else {
            crate::observability::admission(
                crate::observability::Admission::NotificationOrganization,
            );
            return;
        };
        let deadline = tokio::time::Instant::now() + NOTIFICATION_TIMEOUT;
        #[cfg(test)]
        let hold_timeout = self
            .delivery
            .held_notification_timeouts
            .lock()
            .unwrap()
            .contains(&self.key.0);
        #[cfg(test)]
        let delivery = self.delivery.clone();
        #[cfg(test)]
        let publication_key = match &event.payload {
            log::Payload::Create(message) => message.client_message_id,
            log::Payload::Move(event) => event.operation_id,
        };
        #[cfg(test)]
        let gate = PUBLICATION_GATES.get(&publication_key);
        let work = self.delivery.work.enter();
        let task = tokio::spawn(async move {
            let _work = work;
            let _slots = (channel_slot, organization_slot);
            let publication = tokio::time::timeout_at(
                deadline,
                self.delivery
                    .publish(&pool, self.key.0, event, &self.channel.fanout),
            );
            #[cfg(test)]
            let publication = async {
                if hold_timeout {
                    Ok(publication.into_inner().await)
                } else {
                    publication.await
                }
            };
            self.completed = publication.await.is_ok_and(|result| {
                if let Err(error) = &result {
                    crate::observability::database_failure(error);
                }
                result.is_ok()
            });
            drop(_slots);
            drop(self);
        });
        #[cfg(test)]
        {
            if let Some(gate) = gate {
                *gate.hook_state.abort_handle.lock().unwrap() = Some(task.abort_handle());
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

impl Delivery {
    pub(in crate::messages) async fn commit_for_publication(
        &self,
        tx: commit::Transaction,
        key: Uuid,
        organization: Uuid,
        channel: Uuid,
        seq: i64,
    ) -> Result<Notification, MessageError> {
        // Arm before COMMIT so an uncertain outcome or cancellation signals replay.
        let mut notification = self.notification(organization, channel, seq);
        if let Err(error) = commit::finish(tx, key).await {
            if commit::definitely_rolled_back(&error) {
                notification.complete();
            }
            return Err(error.into());
        }
        Ok(notification)
    }

    pub(in crate::messages) fn notification(
        &self,
        organization: Uuid,
        channel: Uuid,
        seq: i64,
    ) -> super::Notification {
        let fanout = self.channel((organization, channel));
        fanout.fanout.first_seq.get_or_init(|| seq);
        Notification {
            delivery: self.clone(),
            key: (organization, channel),
            completed: false,
            channel: fanout,
        }
    }

    pub(super) fn reserve_organization(
        &self,
        organization: Uuid,
        global: tokio::sync::OwnedSemaphorePermit,
    ) -> Option<OrganizationReservation> {
        // Admission and final removal share one short lock: a concurrent release
        // cannot remove a replacement entry. No lock is held during publication.
        // Acquiring global capacity first bounds this map to 2,048 live entries.
        let mut registry = lock_ignoring_poison(&self.organization_notifications);
        let count = registry.entry(organization).or_default();
        if *count == MAX_ORGANIZATION_NOTIFICATIONS {
            return None;
        }
        *count += 1;
        Some(OrganizationReservation {
            registry: self.organization_notifications.clone(),
            organization,
            _global: global,
        })
    }

    // Cursor holds alone cannot stabilize reservations: their 10 s deadline also
    // covers cursor waiting. Configure before spawning; already spawned tasks keep
    // their setting until completion, even if the test later restores deadlines.
    #[cfg(test)]
    pub(crate) fn hold_notification_timeouts(&self, organization: Uuid, hold: bool) {
        let mut held = self.held_notification_timeouts.lock().unwrap();
        if hold {
            held.insert(organization);
        } else {
            held.remove(&organization);
        }
    }

    #[cfg(test)]
    pub(crate) fn notification_permits(&self) -> usize {
        self.notifications.available_permits()
    }

    #[cfg(test)]
    pub(crate) fn notification_reservations(&self) -> (usize, usize) {
        (
            MAX_PENDING_NOTIFICATIONS - self.pending_notifications.available_permits(),
            self.organization_notifications.lock().unwrap().len(),
        )
    }

    #[cfg(test)]
    pub(crate) fn channel_notification_permits(&self, organization: Uuid, channel: Uuid) -> usize {
        self.channel((organization, channel))
            .fanout
            .notifications
            .available_permits()
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
}
