//! Organization notices are invalidations, never Message delivery or authorization grants.
use super::*;
use crate::observability::revocation_trace;
use crate::{get_mut_ignoring_poison, lock_ignoring_poison};
use auth::activity::ChangeScope;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Notify, Semaphore},
    time::Instant,
};
mod dms;
mod fallback_trace;
mod holds;
mod revocations;
pub(crate) use dms::DmPublication;
use holds::Holds;
pub(crate) use holds::revocation_hold_counts;
use revocations::{Capture, Check, Revocations};

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
#[derive(Clone, Debug, PartialEq, Eq)]
struct Proof {
    role: Role,
    grant: Option<Uuid>,
}
#[derive(Default)]
struct Recovery {
    state: Mutex<RecoveryState>,
}
#[derive(Default)]
struct RecoveryState {
    live: usize,
    settled: bool,
}
impl Recovery {
    fn valid(&self) -> bool {
        let state = lock_ignoring_poison(&self.state);
        state.settled || state.live != 0
    }
}
struct QueryToken {
    valid: AtomicBool,
    recovery: Mutex<Option<Arc<Recovery>>>,
}
impl QueryToken {
    fn new() -> Self {
        Self {
            valid: AtomicBool::new(true),
            recovery: Mutex::new(None),
        }
    }
    fn valid(&self) -> bool {
        self.valid.load(Ordering::Relaxed)
    }
    fn contribute(&self, recovery: &Arc<Recovery>) {
        // Each recipient query enqueues one contribution. Coalescing attaches its
        // token once; subsequent merges keep the same recovery accumulator.
        let mut contribution = lock_ignoring_poison(&self.recovery);
        if contribution.is_none() && self.valid() {
            lock_ignoring_poison(&recovery.state).live += 1;
            *contribution = Some(recovery.clone());
        }
    }
    fn retire(&self) {
        let contribution = lock_ignoring_poison(&self.recovery);
        if self.valid.swap(false, Ordering::Relaxed)
            && let Some(recovery) = contribution.as_ref()
        {
            lock_ignoring_poison(&recovery.state).live -= 1;
        }
    }
}
impl Drop for QueryToken {
    fn drop(&mut self) {
        if self.valid()
            && let Some(recovery) = get_mut_ignoring_poison(&mut self.recovery).as_ref()
        {
            // No query guard, fallback snapshot or frame can fence this token
            // after its last owner drops. Retain its reset authority as one bit,
            // rather than retaining a growing list of completed query tokens.
            let mut state = lock_ignoring_poison(&recovery.state);
            state.settled = true;
            state.live -= 1;
        }
    }
}
#[derive(Clone)]
enum Epoch {
    Notice(u64),
    Revocation(Arc<Capture>),
}
impl Epoch {
    fn retained(&self, b: &Buffer) -> bool {
        match self {
            Self::Notice(epoch) => b.epoch == *epoch,
            Self::Revocation(capture) => capture.check().is_some(),
        }
    }
}
#[cfg_attr(test, derive(Clone))]
struct Pending {
    notice: Notice,
    // Payload-free DM invalidations still retain the causing access lifetime.
    channel: Option<Uuid>,
    epoch: Epoch,
    directory_epoch: Option<u64>,
    proof: Option<Proof>,
    valid: Arc<QueryToken>,
    recovery: Option<Arc<Recovery>>,
}
impl Pending {
    fn recoverable(&self) -> bool {
        self.valid.valid() || self.recovery.as_ref().is_some_and(|r| r.valid())
    }
}
struct InFlight {
    channel: Option<Uuid>,
    proof: Option<Proof>,
    valid: Arc<QueryToken>,
}
#[derive(Default)]
struct Buffer {
    epoch: u64,
    revocations: Revocations,
    holds: Holds,
    directory_epoch: u64,
    pending: VecDeque<Pending>,
    reset: bool,
    proofs: HashMap<Option<Uuid>, Proof>,
    in_flight: HashMap<Uuid, InFlight>,
}
enum Retirement<'a> {
    Notices,
    Mutation(&'a HashMap<Uuid, Capture>),
    MembershipLost(i64),
}
impl Buffer {
    fn retire_notices(&mut self) {
        self.holds.prune(&self.revocations, Instant::now());
        self.epoch = self.epoch.wrapping_add(1);
        let mut pending = std::mem::take(&mut self.pending);
        pending.retain(|p| p.epoch.retained(self));
        self.pending = pending;
        self.in_flight.clear();
        self.proofs.clear();
        self.reset &= !self.pending.is_empty();
    }

    fn apply_revocation(&mut self, check: Check, identity: Option<&Proof>, access: Option<bool>) {
        // A fallback or publication can still fence a hold. Only its scheduled
        // handoff recheck can supply authority to deliver it.
        let access =
            access.filter(|&accessible| accessible || self.holds.deadline(check.id).is_none());
        self.apply_revocation_proof(check, identity, access);
    }

    fn apply_revocation_proof(
        &mut self,
        check: Check,
        identity: Option<&Proof>,
        access: Option<bool>,
    ) {
        if self
            .revocations
            .apply(check, identity.map(|proof| proof.role), access)
        {
            self.retire_notices();
        }
    }
}
struct Authorization {
    entry: Arc<Entry>,
    epoch: u64,
    directory_epoch: Option<u64>,
    id: Uuid,
    valid: Arc<QueryToken>,
}
impl Authorization {
    fn new(
        entry: Arc<Entry>,
        epoch: u64,
        channel: Option<Uuid>,
        directory: bool,
        expected_directory_epoch: Option<u64>,
    ) -> Self {
        let id = Uuid::new_v4();
        let valid = Arc::new(QueryToken::new());
        let directory_epoch = {
            let mut b = lock_ignoring_poison(&entry.buffer);
            let directory_epoch =
                directory.then_some(expected_directory_epoch.unwrap_or(b.directory_epoch));
            if epoch == b.epoch {
                b.in_flight.insert(
                    id,
                    InFlight {
                        channel,
                        proof: None,
                        valid: valid.clone(),
                    },
                );
            }
            directory_epoch
        };
        Self {
            entry,
            epoch,
            directory_epoch,
            id,
            valid,
        }
    }
    fn proved(&self, proof: &Option<Proof>) {
        let mut b = lock_ignoring_poison(&self.entry.buffer);
        if self.epoch == b.epoch
            && (proof.as_ref().is_none_or(|proof| proof.role != Role::Guest)
                || self
                    .directory_epoch
                    .is_none_or(|epoch| b.directory_epoch == epoch))
            && let Some(captured) = b.in_flight.get_mut(&self.id)
        {
            captured.proof = proof.clone();
        }
    }
}
impl Drop for Authorization {
    fn drop(&mut self) {
        lock_ignoring_poison(&self.entry.buffer)
            .in_flight
            .remove(&self.id);
    }
}
struct Entry {
    id: Uuid,
    organization: Uuid,
    member: (Uuid, i64),
    hash: Vec<u8>,
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
            batches: Default::default(),
            #[cfg(test)]
            tasks: Default::default(),
            #[cfg(test)]
            queries: Default::default(),
        }
    }
}
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
    #[cfg(test)]
    pub(crate) async fn drained(&self) {
        self.drained_except(0).await;
    }
    #[cfg(test)]
    pub(crate) async fn drained_except(&self, active: u32) {
        let _permits = self
            .capacity
            .clone()
            .acquire_many_owned(40 - active)
            .await
            .unwrap();
    }
    pub(crate) fn register(&self, auth: &Auth) -> Registration {
        let id = Uuid::new_v4();
        let entry = Arc::new(Entry {
            id,
            organization: auth.identity.organization.organization_id,
            member: (auth.identity.member.id, auth.membership_revision),
            hash: auth.session_hash(),
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
    fn advance_directory_epochs(&self, organization: Uuid) -> HashMap<Uuid, u64> {
        let mut epochs = HashMap::new();
        let entries = lock_ignoring_poison(&self.entries);
        for entry in entries
            .values()
            .filter(|entry| entry.organization == organization)
        {
            let mut b = lock_ignoring_poison(&entry.buffer);
            b.directory_epoch = b.directory_epoch.wrapping_add(1);
            b.pending
                .retain(|pending| pending.directory_epoch.is_none());
            if b.pending.is_empty() {
                b.reset = false;
            }
            epochs.insert(entry.id, b.directory_epoch);
        }
        epochs
    }
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
        let entries: Vec<_> = captured.iter().map(|(e, _)| e.clone()).collect();
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
        let proofs = authorize_notices(pool, &entries, channel).await?;
        let shared_guests =
            if matches!(notice, Notice::MembersChanged) && !self.directory_channels.is_empty() {
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
                        .then_some(authorization.directory_epoch)
                        .flatten(),
                    proof: Some(proof),
                    valid: authorization.valid.clone(),
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

    fn spawn_scoped(
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

    pub(super) fn arm_sections(
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
pub(super) struct SectionsPublication {
    activity: Activity,
    organization: Uuid,
    member: Uuid,
    generation: i64,
}

impl SectionsPublication {
    pub(super) fn committed(self, pool: sqlx::PgPool) {
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
fn enqueue(entry: &Entry, mut pending: Pending) {
    let mut b = lock_ignoring_poison(&entry.buffer);
    if !pending.valid.valid()
        || !pending.epoch.retained(&b)
        || pending
            .directory_epoch
            .is_some_and(|epoch| b.directory_epoch != epoch)
    {
        return;
    }
    b.pending.retain(Pending::recoverable);
    if b.pending.is_empty() {
        b.reset = false;
    }
    let channel = pending.channel;
    if let Some(proof) = &pending.proof {
        let conflict = b.proofs.get(&channel).is_some_and(|old| old != proof);
        let identity_changed = channel.is_none() && b.revocations.observe_identity(proof.role);
        if conflict
            || identity_changed
            || (b.proofs.len() == 256 && !b.proofs.contains_key(&channel))
        {
            b.retire_notices();
            return;
        }
        b.proofs.insert(channel, proof.clone());
    }
    if matches!(
        pending.notice,
        Notice::ChannelAccessGained { .. } | Notice::ChannelAccessRevoked { .. }
    ) && let Some(index) = b
        .pending
        .iter()
        .position(|p| p.notice.key() == pending.notice.key())
    {
        b.pending.remove(index);
        b.pending.push_back(pending);
        entry.wake.notify_one();
        return;
    }
    if let Some(old) = b.pending.iter_mut().find(|p| {
        p.notice.key() == pending.notice.key()
            && (!matches!(pending.notice, Notice::ChannelListChanged) || p.channel == channel)
    }) {
        let recovery = old.recovery.get_or_insert_with(Default::default).clone();
        old.valid.contribute(&recovery);
        pending.valid.contribute(&recovery);
        pending.recovery = Some(recovery);
        match (&mut old.notice, &pending.notice) {
            (Notice::ChannelActivity { seq, .. }, Notice::ChannelActivity { seq: new, .. })
                if *seq >= *new => {}
            (
                Notice::ReadPositionChanged { read_seq, .. },
                Notice::ReadPositionChanged { read_seq: new, .. },
            ) if *read_seq >= *new => {}
            (
                Notice::SectionsChanged { generation },
                Notice::SectionsChanged { generation: new },
            ) if *generation >= *new => {}
            _ => *old = pending,
        }
    } else if b.pending.len() == 256 {
        // Retain one proven contribution. Its lifetime is rechecked before reset handoff.
        b.pending.clear();
        b.reset = true;
        b.pending.push_back(pending);
    } else if !b.reset {
        b.pending.push_back(pending);
    }
    entry.wake.notify_one();
}
impl Registration {
    #[cfg(test)]
    pub(crate) fn isolate_revocation_metrics(
        &self,
    ) -> Arc<crate::observability::RevocationMetrics> {
        self.entry.buffer.lock().unwrap().holds.isolate_metrics()
    }

    #[cfg(test)]
    pub(crate) fn buffered(&self, notice: &Notice) -> bool {
        let b = self.entry.buffer.lock().unwrap();
        b.pending.iter().any(|pending| &pending.notice == notice)
    }

    #[cfg(test)]
    pub(crate) fn revocation_tracking(&self) -> (usize, usize) {
        self.entry.buffer.lock().unwrap().revocations.counts()
    }

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
    Deadline,
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
                        Err(RecheckFailure::Deadline) => break None,
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
        let proofs = tokio::time::timeout_at(deadline, async {
            #[cfg(test)]
            test_pause(
                self.entry.organization,
                check.channel,
                "handoff_recheck",
                Some(self.entry.member.0),
            )
            .await;
            if let Some(capacity) = retry_measurement {
                capacity.count_retry_attempt();
            }
            authorize_batch(pool, &selected).await
        })
        .await
        .map_err(|_| RecheckFailure::Deadline)?
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
async fn authorize_notices(
    pool: &sqlx::PgPool,
    entries: &[Arc<Entry>],
    channel: Option<Uuid>,
) -> Result<Vec<Option<Proof>>, sqlx::Error> {
    let selected: Vec<_> = entries
        .iter()
        .map(|entry| (entry.clone(), channel))
        .collect();
    authorize_batch(pool, &selected).await
}
async fn directory_guests(
    pool: &sqlx::PgPool,
    organization: Uuid,
    entries: &[Arc<Entry>],
    channels: &[Uuid],
) -> Result<HashSet<Uuid>, sqlx::Error> {
    let guests: Vec<_> = entries.iter().map(|entry| entry.member.0).collect();
    let rows: Vec<Uuid> = crate::database::organization_statement(
        pool,
        "SELECT DISTINCT cm.member_id FROM channel_members cm \
         JOIN users u ON u.organization_id=cm.organization_id AND u.id=cm.member_id \
         AND u.membership_revision=cm.membership_revision \
         JOIN channels c ON c.organization_id=cm.organization_id AND c.id=cm.channel_id \
         WHERE cm.organization_id=$1 AND cm.channel_id=ANY($2) AND cm.member_id=ANY($3) \
         AND u.deactivated_at IS NULL AND u.role='guest'",
        async |tx: &mut sqlx::PgConnection, sql: &str| {
            sqlx::query_scalar(sql)
                .bind(organization)
                .bind(channels)
                .bind(guests)
                .fetch_all(tx)
                .await
        },
    )
    .await?;
    Ok(rows.into_iter().collect())
}
async fn authorize_batch(
    pool: &sqlx::PgPool,
    selected: &[(Arc<Entry>, Option<Uuid>)],
) -> Result<Vec<Option<Proof>>, sqlx::Error> {
    let entries: Vec<_> = selected.iter().map(|(entry, _)| entry.clone()).collect();
    let Some(first) = entries.first() else {
        return Ok(Vec::new());
    };
    let public_roles = auth::authorization::channel_roles_sql(false);
    let explicit_roles = auth::authorization::channel_roles_sql(true);
    // Keep generic plans correlated to supplied Session keys rather than
    // materializing unrelated Sessions before matching the notice recipients.
    let sql = format!("SELECT u.role, CASE WHEN c.visibility='public' AND u.role IN ({public_roles}) THEN NULL ELSE cm.grant_id END AS grant_id, r.n
        FROM unnest($2::uuid[], $3::bigint[], $4::bytea[], $5::uuid[]) WITH ORDINALITY r(member_id,revision,hash,channel,n)
        LEFT JOIN LATERAL (SELECT * FROM ({}) candidate WHERE candidate.organization_id=$1 AND candidate.id=r.member_id AND candidate.membership_revision=r.revision AND candidate.token_hash=r.hash OFFSET 0) u ON true
        LEFT JOIN channels c ON c.organization_id=$1 AND c.id=r.channel
        LEFT JOIN channel_members cm ON cm.organization_id=$1 AND cm.channel_id=c.id AND cm.member_id=u.id AND cm.membership_revision=u.membership_revision
        WHERE r.channel IS NULL OR ((c.kind='channel' AND c.visibility='public' AND u.role IN ({public_roles})) OR (u.role IN ({explicit_roles}) AND cm.grant_id IS NOT NULL AND (c.kind='channel' OR u.id IN(c.lower_member_id,c.higher_member_id)))) ORDER BY r.n", auth::notice_members_sql());
    let rows: Vec<(Option<Role>, Option<Uuid>, i64)> = crate::database::organization_statement(
        pool,
        &sql,
        async |tx: &mut sqlx::PgConnection, sql: &str| {
            sqlx::query_as(sql)
                .bind(first.organization)
                .bind(entries.iter().map(|e| e.member.0).collect::<Vec<_>>())
                .bind(entries.iter().map(|e| e.member.1).collect::<Vec<_>>())
                .bind(entries.iter().map(|e| e.hash.clone()).collect::<Vec<_>>())
                .bind(
                    selected
                        .iter()
                        .map(|(_, channel)| *channel)
                        .collect::<Vec<_>>(),
                )
                .fetch_all(tx)
                .await
        },
    )
    .await?;
    let mut result = vec![None; entries.len()];
    for (role, grant, index) in rows {
        if let Some(role) = role {
            result[(index - 1) as usize] = Some(Proof { role, grant });
        }
    }
    Ok(result)
}

#[derive(Default, PartialEq, Eq)]
struct TargetState {
    identity: Option<(Role, i64)>,
    peer_identity: Option<(String, bool)>,
    dm_grants: HashSet<Uuid>,
    visible: HashMap<Uuid, (Option<Uuid>, bool, bool)>,
}
async fn target_state(
    tx: &mut sqlx::PgConnection,
    organization: Uuid,
    target: Uuid,
) -> Result<TargetState, sqlx::Error> {
    let identity = auth::activity::notice_target(tx, organization, target).await?;
    let peer_identity = auth::members::participants(tx, organization, &[target], false)
        .await?
        .into_iter()
        .next()
        .map(|m| (m.name, m.active));
    let Some((role, revision)) = identity else {
        return Ok(TargetState {
            peer_identity,
            ..Default::default()
        });
    };
    let public = auth::authorization::channel_roles_sql(false);
    let dm_grants = sqlx::query_scalar("SELECT c.id FROM channels c JOIN channel_members cm ON cm.organization_id=c.organization_id AND cm.channel_id=c.id WHERE c.organization_id=$1 AND c.kind='dm' AND cm.member_id=$2 AND cm.membership_revision=$3 AND $2 IN(c.lower_member_id,c.higher_member_id)")
        .bind(organization).bind(target).bind(revision).fetch_all(&mut *tx).await?;
    let sql = format!(
        "SELECT c.id,cm.grant_id,COALESCE(cm.manager,false),c.visibility='public' FROM channels c LEFT JOIN channel_members cm ON cm.organization_id=c.organization_id AND cm.channel_id=c.id AND cm.member_id=$2 AND cm.membership_revision=$3 WHERE c.organization_id=$1 AND c.kind='channel' AND ((c.visibility='public' AND $4::text IN ({public})) OR cm.grant_id IS NOT NULL)"
    );
    let rows: Vec<(Uuid, Option<Uuid>, bool, bool)> = sqlx::query_as(&sql)
        .bind(organization)
        .bind(target)
        .bind(revision)
        .bind(role)
        .fetch_all(tx)
        .await?;
    Ok(TargetState {
        identity,
        peer_identity,
        dm_grants: dm_grants.into_iter().collect(),
        visible: rows
            .into_iter()
            .map(|(id, grant, manager, public)| (id, (grant, manager, public)))
            .collect(),
    })
}
struct TargetChange {
    activity: Activity,
    organization: Uuid,
    target: Uuid,
    before: TargetState,
    registrations: HashMap<Uuid, Capture>,
    channel: Option<Uuid>,
    dm_peers: Vec<(Uuid, Uuid, bool)>,
    retired: bool,
}
impl auth::activity::ActivityChanges for Activity {
    fn channel(
        &self,
        pool: sqlx::PgPool,
        organization: Uuid,
        change: auth::activity::ChannelChange,
    ) {
        match change {
            auth::activity::ChannelChange::Metadata { channel } => {
                // The wire notice carries no id, but its proof and handoff are Channel-scoped.
                self.spawn_scoped(
                    pool,
                    organization,
                    Notice::ChannelListChanged,
                    Some(channel),
                    None,
                );
            }
            auth::activity::ChannelChange::Created {
                channel,
                creator,
                public,
            } => {
                let mut publisher = self.clone();
                publisher.exclude_guests = true;
                publisher.spawn(
                    pool,
                    organization,
                    Notice::ChannelAccessGained {
                        channel_id: channel,
                    },
                    if public { None } else { Some(creator) },
                );
            }
            auth::activity::ChannelChange::Members { channel } => self.spawn(
                pool,
                organization,
                Notice::ChannelMembersChanged {
                    channel_id: channel,
                },
                None,
            ),
        }
    }
    fn capture<'a>(
        &'a self,
        tx: &'a mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
        scope: ChangeScope,
    ) -> auth::activity::Capture<'a> {
        Box::pin(async move {
            let entries = self
                .snapshot(organization)
                .into_iter()
                .filter(|(entry, _)| entry.member.0 == target)
                .collect::<Vec<_>>();
            let before = target_state(tx, organization, target).await?;
            let registrations = entries
                .into_iter()
                .map(|(entry, _)| {
                    let mut b = lock_ignoring_poison(&entry.buffer);
                    (entry.id, b.revocations.capture(scope))
                })
                .collect();
            Ok(Box::new(TargetChange {
                activity: self.clone(),
                organization,
                target,
                before,
                registrations,
                channel: match scope {
                    ChangeScope::Channel(channel) => Some(channel),
                    _ => None,
                },
                dm_peers: dms::peer_changes(tx, organization, target).await?,
                retired: false,
            }) as Box<dyn auth::activity::ActivityChange>)
        })
    }
    fn directory(&self, pool: sqlx::PgPool, organization: Uuid, target: Uuid) {
        let mut publisher = self.clone();
        publisher.directory_member = Some(target);
        publisher.spawn(pool, organization, Notice::MembersChanged, None);
    }
}
impl auth::activity::ActivityChange for TargetChange {
    fn retire(&mut self) {
        if self.retired {
            return;
        }
        self.retired = true;
        // Retire old work synchronously with observed transition, before starting another snapshot.
        self.activity.retire_inner(
            self.organization,
            self.target,
            Retirement::Mutation(&self.registrations),
        );
        self.activity.directory_epochs = Some(Arc::new(
            self.activity.advance_directory_epochs(self.organization),
        ));
    }
    fn committed(mut self: Box<Self>, pool: sqlx::PgPool) {
        self.retire();
        self.activity.epochs = Some(Arc::new(
            self.activity
                .snapshot(self.organization)
                .iter()
                .map(|(entry, epoch)| (entry.id, *epoch))
                .collect(),
        ));
        let Ok(slot) = self.activity.capacity.clone().try_acquire_owned() else {
            return;
        };
        tokio::spawn(async move {
            let _slot = slot;
            let work = async {
                #[cfg(test)]
                test_pause(
                    self.organization,
                    Uuid::nil(),
                    "target_state",
                    Some(self.target),
                )
                .await;
                let after = crate::database::organization_read_only(
                    &pool,
                    self.organization,
                    async |tx: &mut sqlx::PgConnection| {
                        target_state(tx, self.organization, self.target).await
                    },
                )
                .await?;
                if self.before.peer_identity != after.peer_identity {
                    self.activity
                        .publish_dm(&pool, self.organization, &self.dm_peers)
                        .await?;
                }
                if self.before.identity.is_none() {
                    let mut directory = self.activity.clone();
                    directory.directory_member = Some(self.target);
                    directory
                        .publish(&pool, self.organization, Notice::MembersChanged, None, None)
                        .await?;
                    return Ok::<_, sqlx::Error>(());
                }
                let before_grants: HashSet<_> = self
                    .before
                    .visible
                    .iter()
                    .filter(|(_, (grant, _, _))| grant.is_some())
                    .map(|(channel, _)| *channel)
                    .chain(self.before.dm_grants.iter().copied())
                    .collect();
                let after_grants: HashSet<_> = after
                    .visible
                    .iter()
                    .filter(|(_, (grant, _, _))| grant.is_some())
                    .map(|(channel, _)| *channel)
                    .chain(after.dm_grants.iter().copied())
                    .collect();
                let grants_changed = before_grants != after_grants;
                if let Some((role, revision)) = after.identity
                    && self
                        .before
                        .identity
                        .is_some_and(|(_, before)| before == revision)
                {
                    for (&channel, &(_, _, public)) in &self.before.visible {
                        if self.channel.is_none_or(|changed| changed == channel)
                            && !after.visible.contains_key(&channel)
                        {
                            self.activity
                                .revoked(&pool, &self, channel, public, role)
                                .await?;
                        }
                    }
                    for channel in after
                        .visible
                        .keys()
                        .filter(|id| !self.before.visible.contains_key(id))
                    {
                        self.activity
                            .publish(
                                &pool,
                                self.organization,
                                Notice::ChannelAccessGained {
                                    channel_id: *channel,
                                },
                                Some(self.target),
                                None,
                            )
                            .await?;
                    }
                    self.activity
                        .publish(
                            &pool,
                            self.organization,
                            Notice::ChannelListChanged,
                            Some(self.target),
                            None,
                        )
                        .await?;
                    if after.identity.is_some_and(|r| r.0 == Role::Guest) {
                        self.activity
                            .publish(
                                &pool,
                                self.organization,
                                Notice::MembersChanged,
                                Some(self.target),
                                None,
                            )
                            .await?;
                    }
                }
                if self.before.identity != after.identity || grants_changed {
                    let mut directory = self.activity.clone();
                    directory.directory_member = Some(self.target);
                    directory.directory_channels =
                        before_grants.union(&after_grants).copied().collect();
                    directory
                        .publish(&pool, self.organization, Notice::MembersChanged, None, None)
                        .await?;
                }
                if self.before.identity != after.identity {
                    for channel in self
                        .before
                        .visible
                        .iter()
                        .filter(|(_, (grant, _, _))| grant.is_some())
                        .map(|(id, _)| *id)
                    {
                        self.activity
                            .publish(
                                &pool,
                                self.organization,
                                Notice::ChannelMembersChanged {
                                    channel_id: channel,
                                },
                                None,
                                None,
                            )
                            .await?;
                    }
                }
                Ok::<_, sqlx::Error>(())
            };
            let _ = tokio::time::timeout(Duration::from_secs(10), work).await;
        });
    }
}
impl Activity {
    async fn revoked(
        &self,
        pool: &sqlx::PgPool,
        change: &TargetChange,
        channel: Uuid,
        public: bool,
        role: Role,
    ) -> Result<(), sqlx::Error> {
        let (organization, target) = (change.organization, change.target);
        #[cfg(test)]
        test_pause(organization, channel, "revocation", Some(target)).await;
        let captured: Vec<_> = {
            let entries = lock_ignoring_poison(&self.entries);
            change
                .registrations
                .iter()
                .filter_map(|(id, capture)| {
                    let entry = entries.get(id)?;
                    if entry.organization != organization || entry.member.0 != target {
                        return None;
                    }
                    let _gate = lock_ignoring_poison(&entry.buffer);
                    let capture = capture.notice(channel, public, role)?;
                    let check = capture.check()?;
                    Some((entry.clone(), capture, check))
                })
                .collect()
        };
        #[cfg(test)]
        test_pause(organization, channel, "snapshot", Some(target)).await;
        // The before/after state proved loss. Recheck live identity and absence
        // of access in one snapshot before this revocation can be enqueued.
        #[cfg(test)]
        test_pause(organization, channel, "revoked", Some(target)).await;
        let selected: Vec<_> = captured
            .iter()
            .flat_map(|(entry, _, _)| [(entry.clone(), None), (entry.clone(), Some(channel))])
            .collect();
        let proofs = authorize_batch(pool, &selected).await?;
        #[cfg(test)]
        test_pause(organization, channel, "revocation_authorized", Some(target)).await;
        let (proofs, _) = proofs.as_chunks::<2>();
        for ((entry, capture, check), [identity, access]) in captured.into_iter().zip(proofs) {
            {
                let mut b = lock_ignoring_poison(&entry.buffer);
                b.apply_revocation(check, identity.as_ref(), Some(access.is_some()));
            }
            if identity.is_none() {
                continue;
            }
            enqueue(
                &entry,
                Pending {
                    notice: Notice::ChannelAccessRevoked {
                        channel_id: channel,
                    },
                    channel: None,
                    epoch: Epoch::Revocation(capture),
                    directory_epoch: None,
                    proof: None,
                    valid: Arc::new(QueryToken::new()),
                    recovery: None,
                },
            );
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
                let Ok(proofs) = authorize_batch(pool, &selected).await else {
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

#[cfg(test)]
use crate::test_support::{Gate, Gates};

#[cfg(test)]
type ActivityGateKey = (Uuid, Uuid, &'static str, Option<Uuid>);
#[cfg(test)]
static TEST_GATES: Gates<ActivityGateKey> = Gates::new();
#[cfg(test)]
pub(crate) fn pause(organization: Uuid, channel: Uuid, phase: &'static str) -> Arc<Gate> {
    pause_member(organization, channel, phase, None)
}
#[cfg(test)]
pub(crate) fn pause_member(
    organization: Uuid,
    channel: Uuid,
    phase: &'static str,
    member: Option<Uuid>,
) -> Arc<Gate> {
    TEST_GATES.register((organization, channel, phase, member))
}
#[cfg(test)]
pub(crate) async fn test_pause(
    organization: Uuid,
    channel: Uuid,
    phase: &'static str,
    member: Option<Uuid>,
) {
    // Independent socket gates must not replace each other at the same boundary.
    TEST_GATES
        .pause_with_fallback(
            (organization, channel, phase, member),
            (organization, channel, phase, None),
        )
        .await;
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
        let proofs = authorize_batch(&app, &selected).await.unwrap();
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
            let state = recovery.state.lock().unwrap();
            assert!(state.settled);
            assert_eq!(state.live, 1);
            assert_eq!(Arc::strong_count(recovery), 2);
            drop(state);
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
                senders.add(Some(sender), seq);
            }
            assert_eq!(senders.eligible(alice), Some(2));
            assert_eq!(senders.eligible(bob), Some(3));
            assert_eq!(senders.eligible(third), Some(3));
            assert!(senders.senders.len() <= 2);
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy)]
pub(crate) enum TestFault {
    Database,
    Panic,
}
#[cfg(test)]
static TEST_FAULTS: std::sync::LazyLock<Mutex<HashMap<(Uuid, Uuid), TestFault>>> =
    std::sync::LazyLock::new(Mutex::default);
#[cfg(test)]
pub(crate) fn fail(organization: Uuid, channel: Uuid, fault: TestFault) {
    TEST_FAULTS
        .lock()
        .unwrap()
        .insert((organization, channel), fault);
}
#[cfg(test)]
fn test_fault(organization: Uuid, channel: Uuid) -> Result<(), sqlx::Error> {
    let fault = TEST_FAULTS.lock().unwrap().remove(&(organization, channel));
    match fault {
        Some(TestFault::Database) => Err(sqlx::Error::PoolClosed),
        Some(TestFault::Panic) => panic!("injected notice publisher panic"),
        None => Ok(()),
    }
}
#[cfg(test)]
impl Activity {
    pub(crate) async fn saturate(&self) -> tokio::sync::OwnedSemaphorePermit {
        self.capacity.clone().acquire_many_owned(40).await.unwrap()
    }
    // One abort handle per key: this aborts the most recent spawn for (organization, channel).
    pub(crate) fn cancel(&self, organization: Uuid, channel: Uuid) {
        self.tasks
            .lock()
            .unwrap()
            .remove(&(organization, channel))
            .unwrap()
            .abort();
    }
}
