#[cfg(test)]
use super::test_hooks::{test_fault, test_pause};
use super::{
    Activity, Notice,
    authorize::{Authorization, directory_guests},
    buffer::{Epoch, Pending, enqueue},
};
use crate::{auth::Role, lock_ignoring_poison, observability::notice_permits::NoticeCaller};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

#[derive(Clone, Default)]
pub(crate) struct ActivityBatch {
    senders: Vec<(Uuid, i64)>,
    everyone: Option<i64>,
}
impl ActivityBatch {
    fn add(&mut self, sender: Option<Uuid>, seq: i64) {
        let Some(sender) = sender else {
            self.everyone = self.everyone.max(Some(seq));
            return;
        };
        if let Some(row) = self.senders.iter_mut().find(|r| r.0 == sender) {
            row.1 = row.1.max(seq);
        } else {
            self.senders.push((sender, seq));
        }
        self.senders
            .sort_unstable_by_key(|r| std::cmp::Reverse(r.1));
        self.senders.truncate(2);
    }

    fn eligible(&self, member: Uuid) -> Option<i64> {
        self.everyone
            .max(self.senders.iter().find(|r| r.0 != member).map(|r| r.1))
    }

    fn is_empty(&self) -> bool {
        self.everyone.is_none() && self.senders.is_empty()
    }

    #[cfg(test)]
    pub(super) fn add_for_test(&mut self, sender: Option<Uuid>, seq: i64) {
        self.add(sender, seq);
    }

    #[cfg(test)]
    pub(super) fn eligible_for_test(&self, member: Uuid) -> Option<i64> {
        self.eligible(member)
    }

    #[cfg(test)]
    pub(super) fn sender_count(&self) -> usize {
        self.senders.len()
    }
}

impl Activity {
    pub(crate) fn message(
        &self,
        pool: sqlx::PgPool,
        organization: Uuid,
        channel: Uuid,
        sender: Uuid,
        seq: i64,
    ) {
        self.channel_activity(pool, organization, channel, Some(sender), seq);
    }

    pub(crate) fn message_moved(
        &self,
        pool: sqlx::PgPool,
        organization: Uuid,
        channel: Uuid,
        seq: i64,
    ) {
        self.channel_activity(pool, organization, channel, None, seq);
    }

    fn channel_activity(
        &self,
        pool: sqlx::PgPool,
        organization: Uuid,
        channel: Uuid,
        sender: Option<Uuid>,
        seq: i64,
    ) {
        let key = (organization, channel);
        let mut batches = lock_ignoring_poison(&self.batches);
        if let Some(batch) = batches.get_mut(&key) {
            batch.add(sender, seq);
            return;
        }
        let Ok(slot) = self.capacity.clone().try_acquire_owned() else {
            return;
        };
        let mut batch = ActivityBatch::default();
        batch.add(sender, seq);
        batches.insert(key, batch);
        let this = self.clone();
        let lease = BatchLease {
            batches: self.batches.clone(),
            key,
            finished: false,
        };
        let task = tokio::spawn(async move {
            let mut _lease = lease;
            let _slot = slot;
            loop {
                // Freeze sender maxima before starting authorization. New commits form the next batch.
                let batch = {
                    let mut batches = lock_ignoring_poison(&this.batches);
                    std::mem::take(batches.entry(key).or_default())
                };
                let work = this.publish(
                    &pool,
                    organization,
                    Notice::ChannelActivity {
                        channel_id: channel,
                        seq: 1,
                    },
                    None,
                    Some(&batch),
                );
                let _ = tokio::time::timeout(Duration::from_secs(10), work).await;
                let mut batches = lock_ignoring_poison(&this.batches);
                if batches.get(&key).is_none_or(ActivityBatch::is_empty) {
                    batches.remove(&key);
                    _lease.finished = true;
                    break;
                }
            }
        });
        #[cfg(test)]
        self.tasks.lock().unwrap().insert(key, task.abort_handle());
        #[cfg(not(test))]
        drop(task);
    }
    pub(crate) async fn publish(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        notice: Notice,
        target: Option<Uuid>,
        senders: Option<&ActivityBatch>,
    ) -> Result<(), sqlx::Error> {
        let channel = notice.channel();
        self.publish_scoped(pool, organization, notice, channel, target, senders)
            .await
    }

    async fn publish_scoped(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        notice: Notice,
        channel: Option<Uuid>,
        target: Option<Uuid>,
        senders: Option<&ActivityBatch>,
    ) -> Result<(), sqlx::Error> {
        let captured: Vec<_> = self
            .snapshot(organization)
            .into_iter()
            .filter(|(e, _)| {
                target.is_none_or(|t| e.member.0 == t)
                    && (!matches!(notice, Notice::MembersChanged)
                        || self
                            .directory_epochs
                            .as_ref()
                            .is_none_or(|epochs| epochs.contains_key(&e.id)))
            })
            .collect();
        #[cfg(test)]
        test_pause(
            organization,
            channel.unwrap_or(Uuid::nil()),
            "snapshot",
            target,
        )
        .await;
        let authorizations: Vec<_> = captured
            .iter()
            .map(|(e, epoch)| {
                Authorization::new(
                    e.clone(),
                    *epoch,
                    channel,
                    matches!(notice, Notice::MembersChanged),
                    self.directory_epochs
                        .as_ref()
                        .and_then(|epochs| epochs.get(&e.id).copied()),
                )
            })
            .collect();
        let selected: Vec<_> = captured
            .iter()
            .map(|(entry, _)| (entry.clone(), channel))
            .collect();
        #[cfg(test)]
        if matches!(notice, Notice::ChannelMembersChanged { .. }) {
            test_pause(
                organization,
                channel.unwrap_or(Uuid::nil()),
                "members_query",
                None,
            )
            .await;
        }
        #[cfg(test)]
        test_pause(organization, channel.unwrap_or(Uuid::nil()), "query", None).await;
        #[cfg(test)]
        test_fault(organization, channel.unwrap_or(Uuid::nil()))?;
        #[cfg(test)]
        self.queries
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let proofs = self
            .authorize(pool, &selected, NoticeCaller::Publish)
            .await?;
        let shared_guests =
            if matches!(notice, Notice::MembersChanged) && !self.directory_channels.is_empty() {
                let entries: Vec<_> = selected.into_iter().map(|(entry, _)| entry).collect();
                directory_guests(pool, organization, &entries, &self.directory_channels).await?
            } else {
                HashSet::new()
            };
        for (authorization, proof) in authorizations.iter().zip(&proofs) {
            authorization.proved(proof);
        }
        #[cfg(test)]
        test_pause(
            organization,
            channel.unwrap_or(Uuid::nil()),
            "authorized",
            None,
        )
        .await;
        #[cfg(test)]
        if matches!(notice, Notice::MembersChanged) {
            test_pause(organization, Uuid::nil(), "directory_authorized", None).await;
        }
        for (((entry, epoch), authorization), proof) in
            captured.iter().zip(&authorizations).zip(proofs)
        {
            let Some(proof) = proof else {
                continue;
            };
            if self.exclude_guests && proof.role == Role::Guest {
                continue;
            }
            if matches!(notice, Notice::MembersChanged)
                && proof.role == Role::Guest
                && target != Some(entry.member.0)
                && self.directory_member != Some(entry.member.0)
                && !shared_guests.contains(&entry.member.0)
            {
                continue;
            }
            let mut event = notice.clone();
            if let Some(senders) = senders {
                let Some(seq) = senders.eligible(entry.member.0) else {
                    continue;
                };
                event = Notice::ChannelActivity {
                    channel_id: notice.channel().ok_or(sqlx::Error::RowNotFound)?,
                    seq,
                };
            }
            enqueue(
                entry,
                Pending {
                    notice: event,
                    channel,
                    epoch: Epoch::Notice(*epoch),
                    directory_epoch: (proof.role == Role::Guest)
                        .then_some(authorization.directory_epoch())
                        .flatten(),
                    proof: Some(proof),
                    valid: authorization.valid().clone(),
                    recovery: None,
                },
            );
        }
        Ok(())
    }
    pub(crate) fn spawn(
        &self,
        pool: sqlx::PgPool,
        organization: Uuid,
        notice: Notice,
        target: Option<Uuid>,
    ) {
        let channel = notice.channel();
        self.spawn_scoped(pool, organization, notice, channel, target);
    }

    pub(super) fn spawn_scoped(
        &self,
        pool: sqlx::PgPool,
        organization: Uuid,
        notice: Notice,
        channel: Option<Uuid>,
        target: Option<Uuid>,
    ) {
        let Ok(slot) = self.capacity.clone().try_acquire_owned() else {
            return;
        };
        let this = self.clone();
        #[cfg(test)]
        let key = (organization, channel.unwrap_or(Uuid::nil()));
        let task = tokio::spawn(async move {
            let _slot = slot;
            this.publish_with_deadline(&pool, organization, notice, channel, target)
                .await;
        });
        #[cfg(test)]
        self.tasks.lock().unwrap().insert(key, task.abort_handle());
        #[cfg(not(test))]
        drop(task);
    }

    async fn publish_with_deadline(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        notice: Notice,
        channel: Option<Uuid>,
        target: Option<Uuid>,
    ) {
        let _ = tokio::time::timeout(
            Duration::from_secs(10),
            self.publish_scoped(pool, organization, notice, channel, target, None),
        )
        .await;
    }

    pub(in crate::channels) fn arm_sections(
        &self,
        organization: Uuid,
        member: Uuid,
        generation: i64,
    ) -> SectionsPublication {
        SectionsPublication {
            activity: self.clone(),
            organization,
            member,
            generation,
        }
    }
}

// Construct inside the write transaction and consume after confirmed COMMIT.
// Unconfirmed outcomes and failures without recipient proof recover through O5.
pub(in crate::channels) struct SectionsPublication {
    activity: Activity,
    organization: Uuid,
    member: Uuid,
    generation: i64,
}

impl SectionsPublication {
    pub(in crate::channels) fn committed(self, pool: sqlx::PgPool) {
        self.activity.spawn(
            pool,
            self.organization,
            Notice::SectionsChanged {
                generation: self.generation,
            },
            Some(self.member),
        );
    }
}

struct BatchLease {
    batches: Arc<Mutex<HashMap<(Uuid, Uuid), ActivityBatch>>>,
    key: (Uuid, Uuid),
    finished: bool,
}
impl Drop for BatchLease {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        lock_ignoring_poison(&self.batches).remove(&self.key);
    }
}
