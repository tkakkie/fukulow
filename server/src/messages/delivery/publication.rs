use super::super as messages;
use super::{Delivery, LIVE_QUEUE_CAPACITY, LiveMessage, registry::ChannelFanout};
#[cfg(test)]
use crate::test_support::{Gate, Gates};
use crate::{database::InternalError, lock_ignoring_poison};
#[cfg(test)]
use std::sync::Mutex;
use std::{collections::HashSet, sync::Arc};
use uuid::Uuid;

impl Delivery {
    pub(super) async fn publish(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        event: messages::ChannelEvent,
        channel: &ChannelFanout,
    ) -> Result<(), InternalError> {
        #[cfg(test)]
        publication_gate(match &event.payload {
            messages::log::Payload::Create(message) => message.client_message_id,
            messages::log::Payload::Move(event) => event.operation_id,
        })
        .await;
        let mut cursor = channel.published.lock().await;
        // Cursor waiters hold only their bounded reservations, so one slow Channel
        // cannot exhaust execution capacity needed by unrelated Channels.
        let _permit = self
            .notifications
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                crate::observability::admission(
                    crate::observability::Admission::NotificationExecution,
                );
                InternalError::Saturated
            })?;
        let after =
            cursor.get_or_insert_with(|| channel.first_seq.get().copied().unwrap_or(event.seq) - 1);
        if event.seq <= *after {
            return Ok(());
        }
        // REPLAY_PAGE_SIZE (50) is the effective bound today; the queue-capacity cap only
        // matters if the page size is ever raised above LIVE_QUEUE_CAPACITY.
        let gap = event.seq - *after - 1;
        if gap > messages::REPLAY_PAGE_SIZE || gap > LIVE_QUEUE_CAPACITY as i64 {
            // Latch before skipping: current subscribers reconnect; later subscribers
            // register before taking their committed replay watermark.
            self.failures.signal((organization, event.channel_id));
            *after = event.seq;
            return Ok(());
        }
        // Recover a committed gap once per Channel, never once per subscriber.
        // Each bounded page rechecks current Member revisions and private grants.
        while *after < event.seq - 1 {
            let page =
                messages::replay_page(pool, organization, event.channel_id, *after, event.seq - 1)
                    .await?;
            if page.is_empty() {
                return Err(InternalError::Invariant);
            }
            let last = page
                .last()
                .map(|event| event.seq)
                .ok_or(InternalError::Invariant)?;
            self.fan_out(pool, organization, channel, &page).await;
            *after = last;
        }
        let position = event.seq;
        self.fan_out(pool, organization, channel, &[event]).await;
        *after = position;
        Ok(())
    }

    async fn fan_out(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        channel: &ChannelFanout,
        messages: &[messages::ChannelEvent],
    ) {
        // Only this Channel's lock covers the O(subscribers) snapshot.
        let recipients: Vec<_> = lock_ignoring_poison(&channel.recipients)
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
            messages::mentions::delivery_snapshot(pool, organization, &members, messages).await;
        let Ok((allowed, messages)) = allowed else {
            // No protected delivery on a failed authorization query. Reconnect and replay.
            for sender in &recipients {
                sender.overflow.send_replace(true);
            }
            return;
        };
        for &(id, revision, visible) in &allowed {
            if !visible {
                self.channel_access.observe_loss(
                    organization,
                    messages[0].channel_id,
                    (id, revision),
                );
            }
        }
        let allowed: HashSet<_> = allowed
            .into_iter()
            .filter(|row| row.2)
            .map(|(id, revision, _)| (id, revision))
            .collect();
        let recipients: Vec<_> = recipients
            .iter()
            .filter(|s| allowed.contains(&s.member))
            .collect();
        if recipients.is_empty() {
            return;
        }
        for message in messages {
            let key = (organization, message.channel_id);
            #[cfg(test)]
            self.message_serializations
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let Ok(message) = LiveMessage::from_event(message) else {
                self.failures.signal(key);
                return;
            };
            let message = Arc::new(message);
            for sender in &recipients {
                sender.send(message.clone());
            }
        }
    }

    #[cfg(test)]
    pub(crate) async fn hold_publication_cursor(
        &self,
        organization: Uuid,
        channel: Uuid,
        gate: &Gate,
    ) {
        let lease = self.channel((organization, channel));
        let _cursor = lease.fanout.published.lock().await;
        gate.pause().await;
    }

    #[cfg(test)]
    pub(crate) async fn publication_cursor(
        &self,
        organization: Uuid,
        channel: Uuid,
    ) -> Option<i64> {
        let lease = self.channel((organization, channel));
        *lease.fanout.published.lock().await
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct PublicationTask {
    pub(crate) abort_handle: Mutex<Option<tokio::task::AbortHandle>>,
}
#[cfg(test)]
pub(super) static PUBLICATION_GATES: Gates<Uuid, PublicationTask> = Gates::new();

#[cfg(test)]
pub(crate) fn pause_publication(key: Uuid) -> Arc<Gate<PublicationTask>> {
    PUBLICATION_GATES.register(key)
}

#[cfg(test)]
async fn publication_gate(key: Uuid) {
    PUBLICATION_GATES.pause(key).await;
}
