//! Organization notices are invalidations, never Message delivery or authorization grants.
use super::*;
use crate::lock_ignoring_poison;
use crate::observability::{notice_permits::NoticeCaller, revocation_trace};
use auth::activity::ChangeScope;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Notify, Semaphore},
    time::Instant,
};
mod authorize;
mod buffer;
mod dms;
mod fallback_trace;
mod holds;
mod notice_budget;
mod publish;
mod revocations;
mod target_change;
#[cfg(test)]
mod test_hooks;
#[cfg(test)]
use authorize::directory_guests;
use authorize::{Authorization, authorize_batch};
use buffer::{Buffer, Epoch, Pending, Proof, QueryToken, Recovery, enqueue};
pub(crate) use dms::DmPublication;
pub(crate) use holds::revocation_hold_counts;
use notice_budget::{NoticeBudget, notice_query_slot};
use publish::ActivityBatch;
pub(super) use publish::SectionsPublication;
use revocations::{Capture, Check, Revocations};
#[cfg(test)]
use test_hooks::test_fault;
#[cfg(test)]
pub(crate) use test_hooks::{TestFault, fail, pause, pause_member, test_pause};

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Notice {
    ActivityReady,
    ActivityReset,
    ChannelActivity {
        channel_id: Uuid,
        #[schema(minimum = 1)]
        seq: i64,
    },
    ReadPositionChanged {
        channel_id: Uuid,
        #[schema(required = true)]
        topic_id: Option<Uuid>,
        #[schema(minimum = 0)]
        read_seq: i64,
    },
    ChannelAccessGained {
        channel_id: Uuid,
    },
    ChannelAccessRevoked {
        channel_id: Uuid,
    },
    ChannelListChanged,
    DmListChanged,
    SectionsChanged {
        generation: i64,
    },
    ChannelMembersChanged {
        channel_id: Uuid,
    },
    MembersChanged,
}
impl Notice {
    fn channel(&self) -> Option<Uuid> {
        match self {
            Self::ChannelActivity { channel_id, .. }
            | Self::ReadPositionChanged { channel_id, .. }
            | Self::ChannelAccessGained { channel_id }
            | Self::ChannelAccessRevoked { channel_id }
            | Self::ChannelMembersChanged { channel_id } => Some(*channel_id),
            _ => None,
        }
    }
    fn key(&self) -> (u8, Option<Uuid>, Option<Uuid>) {
        let kind = match self {
            Self::ChannelActivity { .. } => 0,
            Self::ReadPositionChanged { .. } => 1,
            Self::ChannelAccessGained { .. } | Self::ChannelAccessRevoked { .. } => 2,
            Self::ChannelListChanged => 3,
            Self::ChannelMembersChanged { .. } => 4,
            Self::MembersChanged => 5,
            Self::ActivityReset => 6,
            Self::ActivityReady => 7,
            Self::DmListChanged => 8,
            Self::SectionsChanged { .. } => 9,
        };
        (
            kind,
            self.channel(),
            match self {
                Self::ReadPositionChanged { topic_id, .. } => *topic_id,
                _ => None,
            },
        )
    }
}
enum Retirement<'a> {
    Notices,
    Mutation(&'a HashMap<Uuid, Capture>),
    MembershipLost(i64),
}
struct Entry {
    id: Uuid,
    organization: Uuid,
    member: (Uuid, i64),
    hash: Vec<u8>,
    notice_queries: Arc<OnceLock<NoticeBudget>>,
    buffer: Mutex<Buffer>,
    wake: Notify,
}
type Registry = Arc<Mutex<HashMap<Uuid, Arc<Entry>>>>;
#[derive(Clone)]
pub struct Activity {
    entries: Registry,
    epochs: Option<Arc<HashMap<Uuid, u64>>>,
    directory_epochs: Option<Arc<HashMap<Uuid, u64>>>,
    exclude_guests: bool,
    directory_member: Option<Uuid>,
    directory_channels: Vec<Uuid>,
    capacity: Arc<Semaphore>,
    notice_queries: Arc<OnceLock<NoticeBudget>>,
    batches: Arc<Mutex<HashMap<(Uuid, Uuid), ActivityBatch>>>,
    #[cfg(test)]
    tasks: Arc<Mutex<HashMap<(Uuid, Uuid), tokio::task::AbortHandle>>>,
    #[cfg(test)]
    pub(crate) queries: Arc<std::sync::atomic::AtomicUsize>,
}
impl Default for Activity {
    fn default() -> Self {
        Self {
            entries: Default::default(),
            epochs: None,
            directory_epochs: None,
            exclude_guests: false,
            directory_member: None,
            directory_channels: Vec::new(),
            capacity: Arc::new(Semaphore::new(40)),
            notice_queries: Default::default(),
            batches: Default::default(),
            #[cfg(test)]
            tasks: Default::default(),
            #[cfg(test)]
            queries: Default::default(),
        }
    }
}
pub(crate) struct Registration {
    id: Uuid,
    registry: Weak<Mutex<HashMap<Uuid, Arc<Entry>>>>,
    entry: Arc<Entry>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            lock_ignoring_poison(&registry).remove(&self.id);
        }
        let mut b = lock_ignoring_poison(&self.entry.buffer);
        let Buffer {
            holds, revocations, ..
        } = &mut *b;
        holds.close(revocations);
    }
}
impl Activity {
    pub(crate) fn register(&self, auth: &Auth) -> Registration {
        let id = Uuid::new_v4();
        let entry = Arc::new(Entry {
            id,
            organization: auth.identity.organization.organization_id,
            member: (auth.identity.member.id, auth.membership_revision),
            hash: auth.session_hash(),
            notice_queries: self.notice_queries.clone(),
            buffer: Default::default(),
            wake: Notify::new(),
        });
        lock_ignoring_poison(&self.entries).insert(id, entry.clone());
        Registration {
            id,
            registry: Arc::downgrade(&self.entries),
            entry,
        }
    }
    fn snapshot(&self, organization: Uuid) -> Vec<(Arc<Entry>, u64)> {
        lock_ignoring_poison(&self.entries)
            .values()
            .filter_map(|e| {
                if e.organization != organization {
                    return None;
                }
                let b = lock_ignoring_poison(&e.buffer);
                let epoch = b.epoch;
                self.epochs
                    .as_ref()
                    .is_none_or(|epochs| epochs.get(&e.id) == Some(&epoch))
                    .then(|| (e.clone(), epoch))
            })
            .collect()
    }
    pub(crate) fn retire(&self, organization: Uuid, member: Uuid) {
        self.retire_inner(organization, member, Retirement::Notices);
    }
    pub(crate) fn retire_membership(&self, organization: Uuid, member: (Uuid, i64)) {
        self.retire_inner(organization, member.0, Retirement::MembershipLost(member.1));
    }
    fn retire_inner(&self, organization: Uuid, member: Uuid, retirement: Retirement<'_>) {
        for (entry, _) in self
            .snapshot(organization)
            .into_iter()
            .filter(|(e, _)| e.member.0 == member)
        {
            let mut b = lock_ignoring_poison(&entry.buffer);
            match retirement {
                Retirement::Mutation(captures) => {
                    if let Some(capture) = captures.get(&entry.id) {
                        capture.retire();
                    }
                }
                Retirement::MembershipLost(revision) if entry.member.1 == revision => {
                    b.revocations.retire_member();
                }
                Retirement::Notices | Retirement::MembershipLost(_) => {}
            }
            b.retire_notices();
        }
    }
}
impl Registration {
    pub(crate) async fn next(&self) -> Option<NoticeFrame> {
        loop {
            let notified = self.entry.wake.notified();
            #[cfg(test)]
            test_pause(
                self.entry.organization,
                Uuid::nil(),
                "dequeue",
                Some(self.entry.member.0),
            )
            .await;
            let (pending, wake_at) = {
                let mut b = lock_ignoring_poison(&self.entry.buffer);
                let now = Instant::now();
                let Buffer {
                    holds, revocations, ..
                } = &mut *b;
                holds.prune(revocations, now);
                let (retry, wake_at) = holds.due(now);
                if let Some(retry) = retry {
                    return Some(NoticeFrame::new(&self.entry, retry, true));
                }
                (b.pending.pop_front(), wake_at)
            };
            if let Some(pending) = pending {
                #[cfg(test)]
                test_pause(
                    self.entry.organization,
                    pending
                        .channel
                        .or(pending.notice.channel())
                        .unwrap_or(Uuid::nil()),
                    "handoff",
                    Some(self.entry.member.0),
                )
                .await;
                let mut b = lock_ignoring_poison(&self.entry.buffer);
                if !pending.recoverable()
                    || !pending.epoch.retained(&b)
                    || pending
                        .directory_epoch
                        .is_some_and(|epoch| b.directory_epoch != epoch)
                {
                    if b.pending.is_empty() {
                        b.reset = false;
                    }
                    continue;
                }
                let mut pending = pending;
                if b.reset || !pending.valid.valid() {
                    b.reset = false;
                    b.pending.clear();
                    pending.notice = Notice::ActivityReset;
                }
                return Some(NoticeFrame::new(&self.entry, pending, false));
            }
            if let Some(wake_at) = wake_at {
                tokio::select! {
                    () = notified => {},
                    () = tokio::time::sleep_until(wake_at) => {},
                }
            } else {
                notified.await;
            }
        }
    }
}
pub(crate) struct NoticeFrame {
    entry: Arc<Entry>,
    epoch: Epoch,
    directory_epoch: Option<u64>,
    pub event: Notice,
    valid: Arc<QueryToken>,
    recovery: Option<Arc<Recovery>>,
    retry: bool,
}

enum RecheckFailure {
    Database,
    Deadline { caller: NoticeCaller, granted: bool },
}

impl NoticeFrame {
    fn new(entry: &Arc<Entry>, pending: Pending, retry: bool) -> Self {
        Self {
            entry: entry.clone(),
            epoch: pending.epoch,
            directory_epoch: pending.directory_epoch,
            event: pending.notice,
            valid: pending.valid,
            recovery: pending.recovery,
            retry,
        }
    }

    fn parked(&self) -> Pending {
        Pending {
            notice: self.event.clone(),
            channel: None,
            epoch: self.epoch.clone(),
            directory_epoch: self.directory_epoch,
            proof: None,
            valid: self.valid.clone(),
            recovery: self.recovery.clone(),
        }
    }

    pub(crate) fn is_held_retry(&self) -> bool {
        self.retry
    }

    pub(crate) async fn handoff<F: std::future::Future>(
        &self,
        pool: &sqlx::PgPool,
        write: impl FnOnce(Notice) -> F,
    ) -> Option<F::Output> {
        self.poll_handoff(Some(pool), write).await
    }

    async fn poll_handoff<F: std::future::Future>(
        &self,
        pool: Option<&sqlx::PgPool>,
        write: impl FnOnce(Notice) -> F,
    ) -> Option<F::Output> {
        let mut future = std::pin::pin!(async {
            // This body first runs under the handoff gate. Another contribution
            // authorizes recovery, never the discarded larger value.
            let event = if self.valid.valid() {
                self.event.clone()
            } else {
                Notice::ActivityReset
            };
            write(event).await
        });
        let mut first_poll = |cx: &mut std::task::Context<'_>, deadline: Option<Instant>| {
            let mut b = lock_ignoring_poison(&self.entry.buffer);
            if !(self.valid.valid() || self.recovery.as_ref().is_some_and(|r| r.valid()))
                || self
                    .directory_epoch
                    .is_some_and(|epoch| b.directory_epoch != epoch)
            {
                return std::task::Poll::Ready(Ok(None));
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return std::task::Poll::Ready(Ok(None));
            }
            match &self.epoch {
                Epoch::Notice(epoch) if b.epoch != *epoch => {
                    return std::task::Poll::Ready(Ok(None));
                }
                Epoch::Notice(_) => {}
                Epoch::Revocation(capture) => {
                    let Buffer {
                        holds, revocations, ..
                    } = &mut *b;
                    holds.prune(revocations, Instant::now());
                    let Some(check) = capture.check() else {
                        return std::task::Poll::Ready(Ok(None));
                    };
                    let hold_deadline = holds.deadline(check.id);
                    if self.retry {
                        if hold_deadline.is_none() {
                            return std::task::Poll::Ready(Ok(None));
                        }
                    } else if hold_deadline.is_some() {
                        return std::task::Poll::Ready(Ok(None));
                    }
                    if check.needs_recheck {
                        let retry_measurement = if self.retry {
                            holds.retry_measurement()
                        } else {
                            None
                        };
                        return std::task::Poll::Ready(Err((
                            check,
                            hold_deadline,
                            retry_measurement,
                        )));
                    }
                    holds.complete(
                        check.id,
                        self.valid.valid()
                            && matches!(self.event, Notice::ChannelAccessRevoked { .. }),
                    );
                    revocations.finish(check.id);
                }
            }
            std::task::Poll::Ready(Ok(Some(std::future::Future::poll(future.as_mut(), cx))))
        };
        let mut deadline = None;
        let mut last_checked = None;
        let first = loop {
            match std::future::poll_fn(|cx| first_poll(cx, deadline)).await {
                Ok(first) => break first,
                Err((check, hold_deadline, retry_measurement)) => {
                    let checked = (check.generation, check.revision);
                    if last_checked.is_some_and(|last| self.retry || checked <= last) {
                        break None;
                    }
                    last_checked = Some(checked);
                    let deadline = *deadline.get_or_insert_with(|| {
                        let limit = Instant::now() + Duration::from_secs(5);
                        hold_deadline.map_or(limit, |expires| expires.min(limit))
                    });
                    let Some(pool) = pool else { break None };
                    match self
                        .recheck_revocation(pool, check, deadline, retry_measurement)
                        .await
                    {
                        Ok(()) => {}
                        Err(RecheckFailure::Deadline { caller, granted }) => {
                            if let Some(gauges) =
                                NoticeBudget::measurement(&self.entry.notice_queries)
                            {
                                gauges.deadline_exit(caller, granted);
                            }
                            break None;
                        }
                        Err(RecheckFailure::Database) => {
                            if self.retry {
                                let b = lock_ignoring_poison(&self.entry.buffer);
                                b.holds.recheck_error();
                            } else {
                                let (mut b, now) = holds::lock_for_admission(&self.entry);
                                let Buffer {
                                    holds, revocations, ..
                                } = &mut *b;
                                holds.recheck_error();
                                holds.start(&self.entry, revocations, check.id, now);
                            }
                            break None;
                        }
                    }
                }
            }
        };
        if first.is_none()
            && let Epoch::Revocation(capture) = &self.epoch
        {
            let mut b = lock_ignoring_poison(&self.entry.buffer);
            let Buffer {
                holds, revocations, ..
            } = &mut *b;
            let now = Instant::now();
            holds.prune(revocations, now);
            if let Some(check) = capture.check() {
                if self.retry {
                    holds.retry_failed(revocations, check.id, self.parked(), now);
                } else {
                    // Fallback can admit a hold while the initial query is in flight.
                    holds.park(check.id, || self.parked());
                }
            }
        }
        Some(match first? {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => future.await,
        })
    }
    async fn recheck_revocation(
        &self,
        pool: &sqlx::PgPool,
        check: Check,
        deadline: Instant,
        retry_measurement: Option<Arc<holds::Capacity>>,
    ) -> Result<(), RecheckFailure> {
        let selected = [
            (self.entry.clone(), None),
            (self.entry.clone(), Some(check.channel)),
        ];
        let caller = if self.retry {
            NoticeCaller::Retry
        } else {
            NoticeCaller::Handoff
        };
        let granted = AtomicBool::new(false);
        let proofs = tokio::time::timeout_at(deadline, async {
            #[cfg(test)]
            test_pause(
                self.entry.organization,
                check.channel,
                "handoff_recheck",
                Some(self.entry.member.0),
            )
            .await;
            let slot = notice_query_slot(&self.entry.notice_queries, pool, caller).await?;
            if slot.recording() {
                granted.store(true, Ordering::Relaxed);
            }
            if let Some(capacity) = retry_measurement {
                capacity.count_retry_attempt();
            }
            authorize_batch(pool, &selected, Some(&slot)).await
        })
        .await
        .map_err(|_| RecheckFailure::Deadline {
            caller,
            granted: granted.load(Ordering::Relaxed),
        })?
        .map_err(|_| RecheckFailure::Database)?;
        let mut b = lock_ignoring_poison(&self.entry.buffer);
        if self.retry {
            b.apply_revocation_proof(check, proofs[0].as_ref(), Some(proofs[1].is_some()));
        } else {
            b.apply_revocation(check, proofs[0].as_ref(), Some(proofs[1].is_some()));
        }
        Ok(())
    }
}
struct NoticeRecheck {
    channel: Option<Uuid>,
    epoch: u64,
    proof: Option<Proof>,
    valid: Option<Arc<QueryToken>>,
}
impl NoticeRecheck {
    fn apply(&self, b: &mut Buffer, current: Option<&Proof>) {
        if b.epoch != self.epoch
            || self
                .proof
                .as_ref()
                .is_some_and(|proof| current == Some(proof))
        {
            return;
        }
        // Unknown provenance fences only that query. The query may already
        // have completed since this fallback's snapshot.
        if self.proof.is_none()
            && current.is_some()
            && let Some(valid) = &self.valid
        {
            let changed = b
                .proofs
                .get(&self.channel)
                .is_some_and(|known| current != Some(known))
                || b.in_flight.values().any(|authorization| {
                    authorization.channel == self.channel
                        && authorization
                            .proof
                            .as_ref()
                            .is_some_and(|known| current != Some(known))
                });
            if !changed {
                valid.retire();
                for authorization in b.in_flight.values().filter(|authorization| {
                    authorization.channel == self.channel && authorization.proof.is_none()
                }) {
                    authorization.valid.retire();
                }
                return;
            }
        }
        if self.channel.is_none() && current.is_none() {
            b.revocations.retire_member();
        }
        b.retire_notices();
    }
}

enum Recheck {
    Notice(NoticeRecheck),
    Revocation(Check),
}
impl Activity {
    pub(crate) async fn check(&self, pool: &sqlx::PgPool, scope: auth::SubscriptionScope) {
        let timing =
            matches!(scope, auth::SubscriptionScope::All) && revocation_trace::timing_enabled();
        let mut trace = if timing {
            fallback_trace::FallbackTrace::start()
        } else {
            None
        };
        let entries: Vec<_> = lock_ignoring_poison(&self.entries)
            .values()
            .filter(|e| match scope {
                auth::SubscriptionScope::All => true,
                auth::SubscriptionScope::Member(org, member) => {
                    e.organization == org && e.member.0 == member
                }
                auth::SubscriptionScope::Channel(org, _) => e.organization == org,
            })
            .cloned()
            .collect();
        let scanned = entries.len();
        let mut organizations = std::collections::BTreeMap::<_, Vec<_>>::new();
        let mut revocation_cutoffs = HashMap::new();
        for entry in entries {
            let b = lock_ignoring_poison(&entry.buffer);
            let rows = organizations.entry(entry.organization).or_default();
            rows.extend(b.proofs.iter().map(|(&channel, proof)| {
                (
                    entry.clone(),
                    Recheck::Notice(NoticeRecheck {
                        channel,
                        epoch: b.epoch,
                        proof: Some(proof.clone()),
                        valid: None,
                    }),
                )
            }));
            rows.extend(b.in_flight.values().filter(|a| a.valid.valid()).map(|a| {
                (
                    entry.clone(),
                    Recheck::Notice(NoticeRecheck {
                        channel: a.channel,
                        epoch: b.epoch,
                        proof: a.proof.clone(),
                        valid: Some(a.valid.clone()),
                    }),
                )
            }));
            let checks = b.revocations.checks();
            if let Some(last) = checks.last() {
                revocation_cutoffs.insert(entry.id, last.id);
                if let Some(trace) = &mut trace {
                    trace.capture(&entry, &b, &checks, last.id);
                }
            }
            rows.extend(
                checks
                    .into_iter()
                    .map(|check| (entry.clone(), Recheck::Revocation(check))),
            );
        }
        if let Some(trace) = &mut trace {
            trace.snapshot(scanned);
        }
        for rows in organizations.values() {
            let mut remaining = rows.as_slice();
            while !remaining.is_empty() {
                let mut selected = Vec::new();
                let mut offsets = Vec::new();
                for (entry, row) in remaining {
                    let (channel, revocation_channel) = match row {
                        Recheck::Notice(notice) => (notice.channel, None),
                        Recheck::Revocation(check) => (
                            None,
                            Some(check.channel).filter(|checked| !matches!(scope, auth::SubscriptionScope::Channel(_, channel) if channel != *checked)),
                        ),
                    };
                    // Read both proofs in one snapshot without expanding the SQL batch.
                    let index = selected.len();
                    if index + 1 + usize::from(revocation_channel.is_some()) > 1000 {
                        break;
                    }
                    selected.push((entry.clone(), channel));
                    let access = revocation_channel.map(|channel| {
                        selected.push((entry.clone(), Some(channel)));
                        index + 1
                    });
                    offsets.push((index, access));
                }
                let (chunk, rest) = remaining.split_at(offsets.len());
                remaining = rest;
                if let Some(trace) = &mut trace {
                    trace.chunk(selected.len());
                }
                #[cfg(test)]
                for (entry, channel) in &selected {
                    test_pause(
                        entry.organization,
                        channel.unwrap_or(Uuid::nil()),
                        "fallback_snapshot",
                        Some(entry.member.0),
                    )
                    .await;
                }
                let proofs = if matches!(scope, auth::SubscriptionScope::All) {
                    // The Session worker runs this pass serially.
                    let _all_pass = NoticeBudget::all_pass(&self.notice_queries);
                    authorize_batch(pool, &selected, None).await
                } else {
                    self.authorize(pool, &selected, NoticeCaller::Scoped).await
                };
                let Ok(proofs) = proofs else {
                    if let Some(trace) = &mut trace {
                        trace.failed_chunk();
                    }
                    if let Some((entry, _)) = chunk.first() {
                        lock_ignoring_poison(&entry.buffer).holds.recheck_error();
                    }
                    let mut seen = HashSet::new();
                    let mut admission_attempted = false;
                    for (entry, row) in chunk {
                        let mut b = if let Some(&cutoff) = revocation_cutoffs.get(&entry.id)
                            && seen.insert(entry.id)
                        {
                            let (mut b, now) = holds::lock_for_admission(entry);
                            admission_attempted |= timing;
                            let mut admission = trace
                                .as_mut()
                                .and_then(|trace| trace.first_admission(entry.id));
                            let Buffer {
                                holds, revocations, ..
                            } = &mut *b;
                            let mut checks = revocations
                                .checks()
                                .into_iter()
                                .take_while(|check| check.id <= cutoff)
                                .peekable();
                            if checks.peek().is_some() {
                                for check in checks {
                                    holds.start(entry, revocations, check.id, now);
                                    if let Some(record) = &mut admission {
                                        let held = holds.deadline(check.id).is_some();
                                        record.record(
                                            check.id,
                                            held,
                                            !held && revocations.check(check.id).is_some(),
                                        );
                                    }
                                }
                                b.retire_notices();
                                entry.wake.notify_one();
                            }
                            if let Some(record) = admission {
                                record.complete();
                            }
                            b
                        } else {
                            lock_ignoring_poison(&entry.buffer)
                        };
                        if let Recheck::Notice(notice) = row
                            && b.epoch == notice.epoch
                        {
                            b.retire_notices();
                        }
                    }
                    if admission_attempted {
                        revocation_trace::admission_finished();
                    }
                    continue;
                };
                let proof = |index: usize| proofs[index].as_ref();
                for ((entry, row), (index, access)) in chunk.iter().zip(offsets) {
                    let current = proof(index);
                    let mut b = lock_ignoring_poison(&entry.buffer);
                    match row {
                        Recheck::Notice(notice) => notice.apply(&mut b, current),
                        Recheck::Revocation(check) => {
                            b.apply_revocation(*check, current, access.map(|i| proof(i).is_some()));
                        }
                    }
                }
            }
        }
        if let Some(trace) = trace {
            trace.finish();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_role_conflict_requires_fresh_dequeued_revocation_proof() {
        let mut rechecks = Vec::new();
        for (channel_proof, at_cap, only_revocation_proof) in [
            (true, false, false),
            (true, true, false),
            (false, true, false),
            (false, false, false),
            (false, false, true),
        ] {
            let entry = entry();
            let registration = Registration {
                id: entry.id,
                entry: entry.clone(),
                registry: Weak::new(),
            };
            let channel = Uuid::new_v4();
            let revoked = Uuid::new_v4();
            let capture = entry
                .buffer
                .lock()
                .unwrap()
                .revocations
                .capture(ChangeScope::Channel(revoked));
            let mut revocation = pending(revoked, None);
            revocation.notice = Notice::ChannelAccessRevoked {
                channel_id: revoked,
            };
            let notice_capture = capture.notice(revoked, false, Role::Member).unwrap();
            entry.buffer.lock().unwrap().revocations.apply(
                notice_capture.check().unwrap(),
                Some(Role::Member),
                Some(false),
            );
            revocation.epoch = Epoch::Revocation(notice_capture);
            revocation.proof = None;
            enqueue(&entry, revocation);
            let frame = registration.next().await.unwrap();

            let key = channel_proof.then_some(channel);
            let mut conflicting = pending(channel, None);
            conflicting.channel = key;
            let existing = Proof {
                role: Role::Guest,
                grant: None,
            };
            if !channel_proof && !at_cap {
                conflicting.proof = Some(existing);
                if !only_revocation_proof {
                    entry.buffer.lock().unwrap().proofs.insert(
                        None,
                        Proof {
                            role: Role::Member,
                            grant: None,
                        },
                    );
                }
            } else {
                let mut b = entry.buffer.lock().unwrap();
                if at_cap {
                    b.proofs
                        .extend((0..256).map(|_| (Some(Uuid::new_v4()), existing.clone())));
                } else {
                    b.proofs.insert(key, existing);
                }
            }
            enqueue(&entry, conflicting);
            let Epoch::Revocation(capture) = &frame.epoch else {
                panic!("expected a revocation");
            };
            rechecks.push(capture.check().unwrap().needs_recheck);
            let b = entry.buffer.lock().unwrap();
            assert_eq!(b.epoch, 1, "ordinary notices must retire in every case");
            assert!(b.proofs.is_empty());
        }
        assert_eq!(
            rechecks,
            [false, false, false, true, true],
            "Channel mismatch, Channel cap, identity cap, identity cache mismatch, revocation identity mismatch"
        );
    }

    #[fukulow_test::test]
    async fn directory_guests_require_active_current_guest_grants_in_the_organization(
        pool: sqlx::PgPool,
    ) {
        use crate::channels::tests::{member, organization};

        let org = organization(&pool).await;
        let other = organization(&pool).await;
        let channel = Uuid::new_v4();
        for scope in [org, other] {
            sqlx::query("INSERT INTO channels(organization_id,id,name,visibility) VALUES($1,$2,'Public','public')")
                .bind(scope).bind(channel).execute(&pool).await.unwrap();
        }

        let guest = Uuid::new_v4();
        let inactive = Uuid::new_v4();
        let stale = Uuid::new_v4();
        let non_guest = Uuid::new_v4();
        let foreign = Uuid::new_v4();
        let candidates = [
            (org, guest, "guest", 0_i64),
            (org, inactive, "guest", 1),
            (org, stale, "guest", 0),
            (org, non_guest, "member", 0),
            (other, foreign, "guest", 0),
        ];
        // A foreign Guest with the same Member id cannot supply the local Member's Role.
        member(&pool, other, non_guest, "guest").await;
        let mut entries = Vec::new();
        for (scope, id, role, grant_revision) in candidates {
            member(&pool, scope, id, role).await;
            if id == inactive || id == stale {
                sqlx::query(
                    "UPDATE users SET deactivated_at=now() WHERE organization_id=$1 AND id=$2",
                )
                .bind(scope)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
            }
            if id == stale {
                sqlx::query(
                    "UPDATE users SET deactivated_at=NULL WHERE organization_id=$1 AND id=$2",
                )
                .bind(scope)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
            }
            // The inactive grant deliberately matches its Member's bumped revision.
            sqlx::query("INSERT INTO channel_members(organization_id,channel_id,member_id,membership_revision) VALUES($1,$2,$3,$4)")
                .bind(scope).bind(channel).bind(id).bind(grant_revision).execute(&pool).await.unwrap();
            entries.push(Arc::new(Entry {
                id: Uuid::new_v4(),
                organization: scope,
                member: (id, i64::from(id == inactive || id == stale)),
                hash: Vec::new(),
                notice_queries: Default::default(),
                buffer: Default::default(),
                wake: Notify::new(),
            }));
        }

        // Use the fixture owner so RLS cannot hide a missing Organization predicate.
        assert_eq!(
            directory_guests(&pool, org, &entries, &[channel])
                .await
                .unwrap(),
            HashSet::from([guest])
        );
        assert_eq!(
            directory_guests(&pool, other, &entries, &[channel])
                .await
                .unwrap(),
            HashSet::from([foreign])
        );
    }

    #[fukulow_test::test]
    async fn notice_batch_matches_join_and_bounds_session_lookups(pool: sqlx::PgPool) {
        let org = Uuid::new_v4();
        let channel = Uuid::new_v4();
        let members = (0..1000).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
        let hashes = members
            .iter()
            .map(|id| id.as_bytes().repeat(2))
            .collect::<Vec<_>>();
        sqlx::query("INSERT INTO organizations(organization_id,name) VALUES($1,'Notice plan')")
            .bind(org)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO accounts(id,email,password_hash) SELECT id,id::text||'@example.invalid','unused' FROM unnest($1::uuid[]) id")
            .bind(&members).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO users(organization_id,id,account_id,name,role) SELECT $1,id,id,'Member','member' FROM unnest($2::uuid[]) id")
            .bind(org).bind(&members).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO account_sessions(account_id,token_hash) SELECT id,hash FROM unnest($1::uuid[],$2::bytea[]) r(id,hash)")
            .bind(&members).bind(&hashes).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO channels(organization_id,id,name,visibility) VALUES($1,$2,'Public','public')")
            .bind(org).bind(channel).execute(&pool).await.unwrap();
        sqlx::query(
            "UPDATE account_sessions SET expires_at=now()-interval '1 second' WHERE account_id=$1",
        )
        .bind(members[2])
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id=$1 AND id=$2",
        )
        .bind(org)
        .bind(members[3])
        .execute(&pool)
        .await
        .unwrap();
        let selected = members
            .iter()
            .enumerate()
            .map(|(n, id)| {
                (
                    Arc::new(Entry {
                        id: Uuid::new_v4(),
                        organization: org,
                        member: (
                            if n == 4 { Uuid::new_v4() } else { *id },
                            if n == 1 { 1 } else { 0 },
                        ),
                        hash: if n == 0 {
                            vec![0; 32]
                        } else {
                            hashes[n].clone()
                        },
                        notice_queries: Default::default(),
                        buffer: Default::default(),
                        wake: Notify::new(),
                    }),
                    Some(channel),
                )
            })
            .collect::<Vec<_>>();
        let restricted = crate::test_app_pool(pool).await;
        let app = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect_with(restricted.connect_options().as_ref().clone())
            .await
            .unwrap();
        sqlx::query("SET jit=off").execute(&app).await.unwrap();
        sqlx::query("SET plan_cache_mode=force_generic_plan")
            .execute(&app)
            .await
            .unwrap();
        let proofs = authorize_batch(&app, &selected, None).await.unwrap();
        assert!(proofs[..5].iter().all(Option::is_none));
        assert!(proofs[5..].iter().all(Option::is_some));
        let sql: String = sqlx::query_scalar("SELECT statement FROM pg_prepared_statements WHERE statement LIKE 'WITH fukulow_context%' AND statement LIKE '%WITH ORDINALITY r(member_id,revision,hash,channel,n)%' ORDER BY prepare_time DESC LIMIT 1")
            .fetch_one(&app).await.unwrap();
        let old = sql.replace("LEFT JOIN LATERAL (SELECT * FROM (", "LEFT JOIN (")
            .replace(") candidate WHERE candidate.organization_id=$1 AND candidate.id=r.member_id AND candidate.membership_revision=r.revision AND candidate.token_hash=r.hash OFFSET 0) u ON true", ") u ON u.organization_id=$1 AND u.id=r.member_id AND u.membership_revision=r.revision AND u.token_hash=r.hash");
        assert_ne!(old, sql);
        let ids = selected.iter().map(|(e, _)| e.member.0).collect::<Vec<_>>();
        let revisions = selected.iter().map(|(e, _)| e.member.1).collect::<Vec<_>>();
        let hashes = selected
            .iter()
            .map(|(e, _)| e.hash.clone())
            .collect::<Vec<_>>();
        let channels = vec![Some(channel); selected.len()];
        let old_rows: Vec<(Option<Role>, Option<Uuid>, i64)> = sqlx::query_as(&old)
            .bind(org)
            .bind(&ids)
            .bind(&revisions)
            .bind(&hashes)
            .bind(&channels)
            .fetch_all(&app)
            .await
            .unwrap();
        let expected = proofs
            .iter()
            .enumerate()
            .filter_map(|(n, p)| p.as_ref().map(|p| (Some(p.role), p.grant, (n + 1) as i64)))
            .collect::<Vec<_>>();
        assert_eq!(old_rows, expected);
        let plan: serde_json::Value =
            sqlx::query_scalar(&format!("EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) {sql}"))
                .bind(org)
                .bind(&ids)
                .bind(&revisions)
                .bind(&hashes)
                .bind(&channels)
                .fetch_one(&app)
                .await
                .unwrap();
        fn check(node: &serde_json::Value) {
            if node["Relation Name"] == "account_sessions" {
                let examined = node["Actual Rows"].as_f64().unwrap_or(0.0)
                    * node["Actual Loops"].as_f64().unwrap_or(0.0);
                assert!(examined <= 1000.0, "unbounded Session work: {node}");
            }
            if let Some(children) = node["Plans"].as_array() {
                for child in children {
                    check(child);
                }
            }
        }
        check(&plan[0]["Plan"]);
        app.close().await;
        restricted.close().await;
    }
    pub(super) fn entry() -> Arc<Entry> {
        Arc::new(Entry {
            id: Uuid::new_v4(),
            organization: Uuid::new_v4(),
            member: (Uuid::new_v4(), 0),
            hash: vec![],
            notice_queries: Default::default(),
            buffer: Default::default(),
            wake: Notify::new(),
        })
    }
    pub(super) fn pending(channel: Uuid, topic: Option<Uuid>) -> Pending {
        Pending {
            notice: Notice::ReadPositionChanged {
                channel_id: channel,
                topic_id: topic,
                read_seq: 10,
            },
            channel: Some(channel),
            epoch: Epoch::Notice(0),
            directory_epoch: None,
            proof: Some(Proof {
                role: Role::Member,
                grant: None,
            }),
            valid: Arc::new(QueryToken::new()),
            recovery: None,
        }
    }
    #[test]
    fn captured_registration_epochs_never_include_a_replacement_socket() {
        let mut activity = Activity::default();
        let old = entry();
        let mut replacement = entry();
        Arc::get_mut(&mut replacement).unwrap().organization = old.organization;
        Arc::get_mut(&mut replacement).unwrap().member = old.member;
        activity.epochs = Some(Arc::new(HashMap::from([(old.id, 0)])));
        activity
            .entries
            .lock()
            .unwrap()
            .insert(replacement.id, replacement);
        assert!(activity.snapshot(old.organization).is_empty());
    }
    #[test]
    fn newer_access_transition_replaces_the_shared_key_and_moves_to_the_tail() {
        let entry = entry();
        let channel = Uuid::new_v4();
        let mut transition = pending(channel, None);
        transition.notice = Notice::ChannelAccessGained {
            channel_id: channel,
        };
        enqueue(&entry, transition.clone());
        enqueue(&entry, pending(Uuid::new_v4(), None));
        transition.notice = Notice::ChannelAccessRevoked {
            channel_id: channel,
        };
        enqueue(&entry, transition);
        let b = entry.buffer.lock().unwrap();
        assert_eq!(b.pending.len(), 2);
        assert!(matches!(
            b.pending.front().unwrap().notice,
            Notice::ReadPositionChanged { .. }
        ));
        assert_eq!(
            b.pending.back().unwrap().notice,
            Notice::ChannelAccessRevoked {
                channel_id: channel
            }
        );
    }

    #[test]
    fn section_notices_keep_the_numeric_maximum_in_one_key() {
        let entry = entry();
        for generation in [9, 10, 9, i64::MAX, 11] {
            let mut change = pending(Uuid::nil(), None);
            change.notice = Notice::SectionsChanged { generation };
            change.channel = None;
            enqueue(&entry, change);
        }
        let b = entry.buffer.lock().unwrap();
        assert_eq!(b.pending.len(), 1);
        assert_eq!(b.pending[0].notice.key(), (9, None, None));
        assert_eq!(
            b.pending[0].notice,
            Notice::SectionsChanged {
                generation: i64::MAX
            }
        );
    }

    #[tokio::test]
    async fn section_notice_overflow_resets_only_with_a_still_proven_contribution() {
        for loses_proof in [false, true] {
            let entry = entry();
            let channel = Uuid::new_v4();
            for _ in 0..256 {
                enqueue(&entry, pending(channel, Some(Uuid::new_v4())));
            }
            let mut change = pending(Uuid::nil(), None);
            change.notice = Notice::SectionsChanged { generation: 1 };
            change.channel = None;
            let proof = change.valid.clone();
            enqueue(&entry, change);
            let registration = Registration {
                id: entry.id,
                registry: Weak::new(),
                entry: entry.clone(),
            };
            let frame = registration.next().await.unwrap();
            assert_eq!(frame.event, Notice::ActivityReset);
            if loses_proof {
                let _gate = entry.buffer.lock().unwrap();
                proof.retire();
            }
            assert_eq!(
                frame.poll_handoff(None, |event| async { event }).await,
                (!loses_proof).then_some(Notice::ActivityReset)
            );
            let b = entry.buffer.lock().unwrap();
            assert!(b.pending.is_empty());
            assert!(!b.reset);
        }
    }

    #[tokio::test]
    async fn buffer_overflow_with_valid_provenance_latches_one_reset_and_keeps_the_socket_open() {
        let entry = entry();
        let channel = Uuid::new_v4();
        for _ in 0..257 {
            enqueue(&entry, pending(channel, Some(Uuid::new_v4())));
        }
        let registration = Registration {
            id: Uuid::new_v4(),
            registry: Weak::new(),
            entry: entry.clone(),
        };
        assert_eq!(
            registration.next().await.unwrap().event,
            Notice::ActivityReset
        );
        let b = entry.buffer.lock().unwrap();
        assert!(!b.reset);
        assert!(b.pending.is_empty());
    }
    #[tokio::test]
    async fn revocation_purges_buffered_notices_for_that_channel() {
        let activity = Activity::default();
        let entry = entry();
        let channel = Uuid::new_v4();
        activity
            .entries
            .lock()
            .unwrap()
            .insert(Uuid::new_v4(), entry.clone());
        for _ in 0..257 {
            enqueue(&entry, pending(channel, Some(Uuid::new_v4())));
        }
        assert!(entry.buffer.lock().unwrap().reset);
        activity.retire(entry.organization, entry.member.0);
        let b = entry.buffer.lock().unwrap();
        assert!(b.pending.is_empty());
        assert!(b.proofs.is_empty());
        assert!(!b.reset);
        assert_eq!(b.epoch, 1);
    }
    #[tokio::test]
    async fn observed_loss_fences_first_handoff_and_cannot_be_revived_by_regrant() {
        let entry = entry();
        let frame = NoticeFrame {
            entry: entry.clone(),
            epoch: Epoch::Notice(0),
            directory_epoch: None,
            event: Notice::MembersChanged,
            valid: Arc::new(QueryToken::new()),
            recovery: None,
            retry: false,
        };
        entry.buffer.lock().unwrap().epoch = 2;
        let polled = std::sync::atomic::AtomicBool::new(false);
        assert_eq!(
            frame
                .poll_handoff(None, |_| async {
                    polled.store(true, std::sync::atomic::Ordering::SeqCst);
                })
                .await,
            None
        );
        assert!(!polled.load(std::sync::atomic::Ordering::SeqCst));
    }
    #[tokio::test]
    async fn retired_query_fences_enqueue_buffer_reset_and_handoff_without_retiring_other_work() {
        for phase in ["enqueue", "buffer", "reset", "handoff", "coalesce"] {
            let entry = entry();
            let channel = Uuid::new_v4();
            let retired = pending(channel, None);
            let mut allowed = pending(channel, Some(Uuid::new_v4()));
            if phase == "coalesce" {
                allowed.notice = Notice::ReadPositionChanged {
                    channel_id: channel,
                    topic_id: None,
                    read_seq: 5,
                };
            }
            let registration = Registration {
                id: entry.id,
                registry: Weak::new(),
                entry: entry.clone(),
            };
            if phase == "reset" {
                for _ in 0..257 {
                    let mut contribution = retired.clone();
                    contribution.notice = Notice::ReadPositionChanged {
                        channel_id: channel,
                        topic_id: Some(Uuid::new_v4()),
                        read_seq: 10,
                    };
                    enqueue(&entry, contribution);
                }
                assert!(entry.buffer.lock().unwrap().reset);
            } else if phase != "enqueue" {
                enqueue(&entry, retired.clone());
            }
            let frame = if phase == "handoff" {
                registration.next().await
            } else {
                None
            };
            if phase == "buffer" {
                enqueue(&entry, allowed.clone());
            }
            {
                let _gate = entry.buffer.lock().unwrap();
                retired.valid.retire();
            }
            if phase == "enqueue" {
                enqueue(&entry, retired);
                assert!(entry.buffer.lock().unwrap().pending.is_empty());
            }
            if let Some(frame) = frame {
                let polled = AtomicBool::new(false);
                assert!(
                    frame
                        .poll_handoff(None, |_| async { polled.store(true, Ordering::Relaxed) })
                        .await
                        .is_none(),
                    "phase={phase}"
                );
                assert!(!polled.load(Ordering::Relaxed));
            }
            if phase != "buffer" {
                enqueue(&entry, allowed.clone());
            }
            let frame = tokio::time::timeout(Duration::from_secs(1), registration.next())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(frame.event, allowed.notice, "phase={phase}");
            assert_eq!(
                frame.poll_handoff(None, |_| async { true }).await,
                Some(true)
            );
            let b = entry.buffer.lock().unwrap();
            assert_eq!(b.epoch, 0, "phase={phase}");
            assert!(b.pending.is_empty(), "phase={phase}");
            assert!(!b.reset, "phase={phase}");
        }
    }
    #[tokio::test]
    async fn coalesced_query_fence_recovers_at_dequeue_and_first_handoff() {
        for read_position in [false, true] {
            for (first, second, fence_first) in [(1, 2, false), (2, 1, true), (2, 2, true)] {
                for fence in [false, true] {
                    for handoff in [false, true] {
                        let entry = entry();
                        let channel = Uuid::new_v4();
                        let notice = |value| {
                            if read_position {
                                Notice::ReadPositionChanged {
                                    channel_id: channel,
                                    topic_id: None,
                                    read_seq: value,
                                }
                            } else {
                                Notice::ChannelActivity {
                                    channel_id: channel,
                                    seq: value,
                                }
                            }
                        };
                        let mut a = pending(channel, None);
                        a.notice = notice(first);
                        let mut b = pending(channel, None);
                        b.notice = notice(second);
                        let winner = if fence_first {
                            a.valid.clone()
                        } else {
                            b.valid.clone()
                        };
                        let independent = if fence_first {
                            b.valid.clone()
                        } else {
                            a.valid.clone()
                        };
                        enqueue(&entry, a);
                        enqueue(&entry, b);
                        assert_eq!(entry.buffer.lock().unwrap().pending.len(), 1);
                        let registration = Registration {
                            id: entry.id,
                            registry: Weak::new(),
                            entry: entry.clone(),
                        };
                        let frame = if handoff {
                            Some(registration.next().await.unwrap())
                        } else {
                            None
                        };
                        if fence {
                            let _gate = entry.buffer.lock().unwrap();
                            winner.retire();
                        }
                        assert!(independent.valid());
                        let frame = match frame {
                            Some(frame) => frame,
                            None => registration.next().await.unwrap(),
                        };
                        let expected = if fence {
                            Notice::ActivityReset
                        } else {
                            notice(2)
                        };
                        assert_eq!(
                            frame.poll_handoff(None, |event| async { event }).await,
                            Some(expected)
                        );
                        let buffer = entry.buffer.lock().unwrap();
                        assert_eq!(buffer.epoch, 0);
                        assert!(buffer.pending.is_empty());
                        assert!(!buffer.reset);
                    }
                }
            }
        }
    }
    #[tokio::test]
    async fn coalesced_recovery_requires_a_valid_contribution_and_current_epochs() {
        for denial in ["all_queries", "socket_epoch", "directory_epoch"] {
            let entry = entry();
            let channel = Uuid::new_v4();
            let mut a = pending(channel, None);
            let mut b = pending(channel, None);
            a.directory_epoch = Some(0);
            b.directory_epoch = Some(0);
            let first = a.valid.clone();
            let second = b.valid.clone();
            enqueue(&entry, a);
            enqueue(&entry, b);
            let registration = Registration {
                id: entry.id,
                registry: Weak::new(),
                entry: entry.clone(),
            };
            let frame = registration.next().await.unwrap();
            {
                let mut buffer = entry.buffer.lock().unwrap();
                first.retire();
                match denial {
                    "all_queries" => second.retire(),
                    "socket_epoch" => buffer.epoch += 1,
                    "directory_epoch" => buffer.directory_epoch += 1,
                    _ => unreachable!(),
                }
            }
            let polled = AtomicBool::new(false);
            assert_eq!(
                frame
                    .poll_handoff(None, |_| async { polled.store(true, Ordering::Relaxed) })
                    .await,
                None,
                "{denial}"
            );
            assert!(!polled.load(Ordering::Relaxed));
            // A new, independently authorized contribution still works.
            let mut fresh = pending(channel, None);
            fresh.epoch = Epoch::Notice(entry.buffer.lock().unwrap().epoch);
            enqueue(&entry, fresh.clone());
            let fresh_frame = registration.next().await.unwrap();
            assert_eq!(
                fresh_frame
                    .poll_handoff(None, |event| async { event })
                    .await,
                Some(fresh.notice)
            );
        }
    }
    #[tokio::test]
    async fn coalesced_recovery_compacts_completed_queries_without_retaining_tokens() {
        let entry = entry();
        let channel = Uuid::new_v4();
        let mut first = pending(channel, None);
        first.notice = Notice::ChannelActivity {
            channel_id: channel,
            seq: 1,
        };
        let discarded = Arc::downgrade(&first.valid);
        enqueue(&entry, first);
        for seq in 2..=4096 {
            let mut next = pending(channel, None);
            next.notice = Notice::ChannelActivity {
                channel_id: channel,
                seq,
            };
            enqueue(&entry, next);
        }
        assert!(discarded.upgrade().is_none());
        {
            let buffer = entry.buffer.lock().unwrap();
            assert_eq!(buffer.pending.len(), 1);
            assert_eq!(buffer.proofs.len(), 1);
            let pending = buffer.pending.front().unwrap();
            let recovery = pending.recovery.as_ref().unwrap();
            let (live, settled) = recovery.snapshot();
            assert!(settled);
            assert_eq!(live, 1);
            assert_eq!(Arc::strong_count(recovery), 2);
            pending.valid.retire();
        }
        // A later smaller value must not hide recovery for an earlier valid
        // larger contribution after the selected maximum was fenced.
        let mut smaller = pending(channel, None);
        smaller.notice = Notice::ChannelActivity {
            channel_id: channel,
            seq: 1,
        };
        enqueue(&entry, smaller);
        assert_eq!(entry.buffer.lock().unwrap().pending.len(), 1);
        let registration = Registration {
            id: entry.id,
            registry: Weak::new(),
            entry,
        };
        let frame = registration.next().await.unwrap();
        assert_eq!(
            frame.poll_handoff(None, |event| async { event }).await,
            Some(Notice::ActivityReset)
        );
    }
    #[test]
    fn two_sender_maxima_keep_each_recipients_other_sender_seq_in_both_orders() {
        let alice = Uuid::new_v4();
        let bob = Uuid::new_v4();
        let third = Uuid::new_v4();
        for rows in [
            [(alice, 1), (bob, 2), (alice, 3)],
            [(bob, 2), (alice, 3), (alice, 1)],
        ] {
            let mut senders = ActivityBatch::default();
            for (sender, seq) in rows {
                senders.add_for_test(Some(sender), seq);
            }
            assert_eq!(senders.eligible_for_test(alice), Some(2));
            assert_eq!(senders.eligible_for_test(bob), Some(3));
            assert_eq!(senders.eligible_for_test(third), Some(3));
            assert!(senders.sender_count() <= 2);
        }
    }
}
