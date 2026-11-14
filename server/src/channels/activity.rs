//! Organization notices are invalidations, never Message delivery or authorization grants.
use super::*;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{Notify, Semaphore};

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
#[derive(Clone)]
struct Pending {
    notice: Notice,
    epoch: u64,
    directory_epoch: Option<u64>,
    proof: Option<Proof>,
}
#[derive(Default)]
struct Buffer {
    epoch: u64,
    directory_epoch: u64,
    pending: VecDeque<Pending>,
    reset: bool,
    proofs: HashMap<Option<Uuid>, Proof>,
    in_flight: HashMap<Uuid, (Option<Uuid>, Option<Proof>)>,
}
struct Authorization {
    entry: Arc<Entry>,
    epoch: u64,
    directory_epoch: Option<u64>,
    id: Uuid,
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
        let directory_epoch = {
            let mut b = entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
            let directory_epoch =
                directory.then_some(expected_directory_epoch.unwrap_or(b.directory_epoch));
            if b.epoch == epoch {
                b.in_flight.insert(id, (channel, None));
            }
            directory_epoch
        };
        Self {
            entry,
            epoch,
            directory_epoch,
            id,
        }
    }
    fn proved(&self, proof: &Option<Proof>) {
        let mut b = self.entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
        if b.epoch == self.epoch
            && (proof.as_ref().is_none_or(|proof| proof.role != Role::Guest)
                || self
                    .directory_epoch
                    .is_none_or(|epoch| b.directory_epoch == epoch))
            && let Some((_, captured)) = b.in_flight.get_mut(&self.id)
        {
            *captured = proof.clone();
        }
    }
}
impl Drop for Authorization {
    fn drop(&mut self) {
        self.entry
            .buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
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
    batches: Arc<Mutex<HashMap<(Uuid, Uuid), Senders>>>,
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
pub(crate) struct Senders(Vec<(Uuid, i64)>);
impl Senders {
    fn add(&mut self, sender: Uuid, seq: i64) {
        if let Some(row) = self.0.iter_mut().find(|r| r.0 == sender) {
            row.1 = row.1.max(seq);
        } else {
            self.0.push((sender, seq));
        }
        self.0.sort_unstable_by_key(|r| std::cmp::Reverse(r.1));
        self.0.truncate(2);
    }
    fn eligible(&self, member: Uuid) -> Option<i64> {
        self.0.iter().find(|r| r.0 != member).map(|r| r.1)
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
            registry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.id);
        }
    }
}
impl Activity {
    #[cfg(test)]
    pub(crate) async fn drained(&self) {
        let _permits = self.capacity.clone().acquire_many_owned(40).await.unwrap();
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
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, entry.clone());
        Registration {
            id,
            registry: Arc::downgrade(&self.entries),
            entry,
        }
    }
    fn snapshot(&self, organization: Uuid) -> Vec<(Arc<Entry>, u64)> {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(|e| {
                if e.organization != organization {
                    return None;
                }
                let b = e.buffer.lock().unwrap_or_else(|error| error.into_inner());
                let epoch = b.epoch;
                self.epochs
                    .as_ref()
                    .is_none_or(|epochs| epochs.get(&e.id) == Some(&epoch))
                    .then(|| (e.clone(), epoch))
            })
            .collect()
    }
    pub(crate) fn retire(&self, organization: Uuid, member: Uuid) {
        for (entry, _) in self
            .snapshot(organization)
            .into_iter()
            .filter(|(e, _)| e.member.0 == member)
        {
            let mut b = entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
            b.epoch = b.epoch.wrapping_add(1);
            b.pending.clear();
            b.proofs.clear();
            b.in_flight.clear();
            b.reset = false;
        }
    }
    fn advance_directory_epochs(&self, organization: Uuid) -> HashMap<Uuid, u64> {
        let mut epochs = HashMap::new();
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        for entry in entries
            .values()
            .filter(|entry| entry.organization == organization)
        {
            let mut b = entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
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
        let key = (organization, channel);
        let mut batches = self.batches.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(batch) = batches.get_mut(&key) {
            batch.add(sender, seq);
            return;
        }
        let Ok(slot) = self.capacity.clone().try_acquire_owned() else {
            return;
        };
        let mut batch = Senders::default();
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
                    let mut batches = this.batches.lock().unwrap_or_else(|e| e.into_inner());
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
                let mut batches = this.batches.lock().unwrap_or_else(|e| e.into_inner());
                if batches.get(&key).is_none_or(|b| b.0.is_empty()) {
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
        senders: Option<&Senders>,
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
            notice.channel().unwrap_or(Uuid::nil()),
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
                    notice.channel(),
                    matches!(notice, Notice::MembersChanged),
                    self.directory_epochs
                        .as_ref()
                        .and_then(|epochs| epochs.get(&e.id).copied()),
                )
            })
            .collect();
        let entries: Vec<_> = captured.iter().map(|(e, _)| e.clone()).collect();
        #[cfg(test)]
        test_pause(
            organization,
            notice.channel().unwrap_or(Uuid::nil()),
            "query",
            None,
        )
        .await;
        #[cfg(test)]
        test_fault(organization, notice.channel().unwrap_or(Uuid::nil()))?;
        #[cfg(test)]
        self.queries
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let proofs = authorize_notices(pool, &entries, notice.channel()).await?;
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
            notice.channel().unwrap_or(Uuid::nil()),
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
                    epoch: *epoch,
                    directory_epoch: (proof.role == Role::Guest)
                        .then_some(authorization.directory_epoch)
                        .flatten(),
                    proof: Some(proof),
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
        let Ok(slot) = self.capacity.clone().try_acquire_owned() else {
            return;
        };
        let this = self.clone();
        #[cfg(test)]
        let key = (organization, notice.channel().unwrap_or(Uuid::nil()));
        let task = tokio::spawn(async move {
            let _slot = slot;
            let _ = tokio::time::timeout(
                Duration::from_secs(10),
                this.publish(&pool, organization, notice, target, None),
            )
            .await;
        });
        #[cfg(test)]
        self.tasks.lock().unwrap().insert(key, task.abort_handle());
        #[cfg(not(test))]
        drop(task);
    }
}
fn enqueue(entry: &Entry, pending: Pending) {
    let mut b = entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
    if b.epoch != pending.epoch
        || pending
            .directory_epoch
            .is_some_and(|epoch| b.directory_epoch != epoch)
    {
        return;
    }
    let channel = if matches!(pending.notice, Notice::ChannelAccessRevoked { .. }) {
        None
    } else {
        pending.notice.channel()
    };
    if let Some(proof) = &pending.proof {
        if b.proofs.get(&channel).is_some_and(|old| old != proof)
            || (b.proofs.len() == 256 && !b.proofs.contains_key(&channel))
        {
            b.epoch = b.epoch.wrapping_add(1);
            b.pending.clear();
            b.proofs.clear();
            b.in_flight.clear();
            b.reset = false;
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
    if let Some(old) = b
        .pending
        .iter_mut()
        .find(|p| p.notice.key() == pending.notice.key())
    {
        match (&mut old.notice, &pending.notice) {
            (Notice::ChannelActivity { seq, .. }, Notice::ChannelActivity { seq: new, .. }) => {
                *seq = (*seq).max(*new)
            }
            (
                Notice::ReadPositionChanged { read_seq, .. },
                Notice::ReadPositionChanged { read_seq: new, .. },
            ) => *read_seq = (*read_seq).max(*new),
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
    pub(crate) async fn next(&self) -> Option<NoticeFrame> {
        loop {
            let notified = self.entry.wake.notified();
            let pending = {
                self.entry
                    .buffer
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .pending
                    .pop_front()
            };
            if let Some(pending) = pending {
                #[cfg(test)]
                test_pause(
                    self.entry.organization,
                    pending.notice.channel().unwrap_or(Uuid::nil()),
                    "handoff",
                    Some(self.entry.member.0),
                )
                .await;
                let mut b = self.entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
                if b.epoch != pending.epoch
                    || pending
                        .directory_epoch
                        .is_some_and(|epoch| b.directory_epoch != epoch)
                {
                    continue;
                }
                let event = if b.reset {
                    b.reset = false;
                    b.pending.clear();
                    Notice::ActivityReset
                } else {
                    pending.notice
                };
                return Some(NoticeFrame {
                    entry: self.entry.clone(),
                    epoch: pending.epoch,
                    directory_epoch: pending.directory_epoch,
                    event,
                });
            }
            notified.await;
        }
    }
}
pub(crate) struct NoticeFrame {
    entry: Arc<Entry>,
    epoch: u64,
    directory_epoch: Option<u64>,
    pub event: Notice,
}
impl NoticeFrame {
    pub(crate) async fn handoff<F: std::future::Future>(&self, future: F) -> Option<F::Output> {
        let mut future = std::pin::pin!(future);
        let first = std::future::poll_fn(|cx| {
            let b = self.entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
            std::task::Poll::Ready(
                if b.epoch == self.epoch
                    && self
                        .directory_epoch
                        .is_none_or(|epoch| b.directory_epoch == epoch)
                {
                    Some(std::future::Future::poll(future.as_mut(), cx))
                } else {
                    None
                },
            )
        })
        .await?;
        Some(match first {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => future.await,
        })
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
    let sql = format!("SELECT u.role, CASE WHEN c.visibility='public' AND u.role IN ({public_roles}) THEN NULL ELSE cm.grant_id END AS grant_id, r.n
        FROM unnest($2::uuid[], $3::bigint[], $4::bytea[], $5::uuid[]) WITH ORDINALITY r(member_id,revision,hash,channel,n)
        LEFT JOIN ({}) u ON u.organization_id=$1 AND u.id=r.member_id AND u.membership_revision=r.revision AND u.token_hash=r.hash
        LEFT JOIN channels c ON c.organization_id=$1 AND c.id=r.channel
        LEFT JOIN channel_members cm ON cm.organization_id=$1 AND cm.channel_id=c.id AND cm.member_id=u.id AND cm.membership_revision=u.membership_revision
        WHERE r.channel IS NULL OR ((c.visibility='public' AND u.role IN ({public_roles})) OR (u.role IN ({explicit_roles}) AND cm.grant_id IS NOT NULL)) ORDER BY r.n", auth::notice_members_sql());
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
    visible: HashMap<Uuid, (Option<Uuid>, bool)>,
}
async fn target_state(
    tx: &mut sqlx::PgConnection,
    organization: Uuid,
    target: Uuid,
) -> Result<TargetState, sqlx::Error> {
    let identity = auth::activity::notice_target(tx, organization, target).await?;
    let Some((role, revision)) = identity else {
        return Ok(TargetState::default());
    };
    let public = auth::authorization::channel_roles_sql(false);
    let sql = format!(
        "SELECT c.id,cm.grant_id,COALESCE(cm.manager,false) FROM channels c LEFT JOIN channel_members cm ON cm.organization_id=c.organization_id AND cm.channel_id=c.id AND cm.member_id=$2 AND cm.membership_revision=$3 WHERE c.organization_id=$1 AND ((c.visibility='public' AND $4::text IN ({public})) OR cm.grant_id IS NOT NULL)"
    );
    let rows: Vec<(Uuid, Option<Uuid>, bool)> = sqlx::query_as(&sql)
        .bind(organization)
        .bind(target)
        .bind(revision)
        .bind(role)
        .fetch_all(tx)
        .await?;
    Ok(TargetState {
        identity,
        visible: rows
            .into_iter()
            .map(|(id, grant, manager)| (id, (grant, manager)))
            .collect(),
    })
}
struct TargetChange {
    activity: Activity,
    organization: Uuid,
    target: Uuid,
    before: TargetState,
    registrations: HashMap<Uuid, u64>,
}
impl auth::activity::ActivityChanges for Activity {
    fn channel(
        &self,
        pool: sqlx::PgPool,
        organization: Uuid,
        change: auth::activity::ChannelChange,
    ) {
        match change {
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
    ) -> auth::activity::Capture<'a> {
        Box::pin(async move {
            let registrations = self
                .snapshot(organization)
                .into_iter()
                .filter(|(entry, _)| entry.member.0 == target)
                .map(|(entry, epoch)| (entry.id, epoch))
                .collect();
            Ok(Box::new(TargetChange {
                activity: self.clone(),
                organization,
                target,
                before: target_state(tx, organization, target).await?,
                registrations,
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
    fn committed(mut self: Box<Self>, pool: sqlx::PgPool) {
        // Retire old work synchronously with observed transition, before starting another snapshot.
        self.activity.retire(self.organization, self.target);
        self.activity.directory_epochs = Some(Arc::new(
            self.activity.advance_directory_epochs(self.organization),
        ));
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
                let after = crate::database::organization_read_only(
                    &pool,
                    self.organization,
                    async |tx: &mut sqlx::PgConnection| {
                        target_state(tx, self.organization, self.target).await
                    },
                )
                .await?;
                let before_grants: HashSet<_> = self
                    .before
                    .visible
                    .iter()
                    .filter(|(_, (grant, _))| grant.is_some())
                    .map(|(channel, _)| *channel)
                    .collect();
                let after_grants: HashSet<_> = after
                    .visible
                    .iter()
                    .filter(|(_, (grant, _))| grant.is_some())
                    .map(|(channel, _)| *channel)
                    .collect();
                let grants_changed = before_grants != after_grants;
                let live_same_revision = after.identity.is_some_and(|(_, revision)| {
                    self.before
                        .identity
                        .is_none_or(|(_, before)| before == revision)
                });
                if live_same_revision {
                    for channel in self
                        .before
                        .visible
                        .keys()
                        .filter(|id| !after.visible.contains_key(id))
                    {
                        self.activity
                            .revoked(
                                &pool,
                                self.organization,
                                self.target,
                                *channel,
                                &self.registrations,
                            )
                            .await?;
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
                        .filter(|(_, (grant, _))| grant.is_some())
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
        organization: Uuid,
        target: Uuid,
        channel: Uuid,
        registrations: &HashMap<Uuid, u64>,
    ) -> Result<(), sqlx::Error> {
        let captured: Vec<_> = self
            .snapshot(organization)
            .into_iter()
            .filter(|(e, epoch)| {
                e.member.0 == target
                    && registrations
                        .get(&e.id)
                        .is_some_and(|before| *epoch == before.wrapping_add(1))
            })
            .collect();
        #[cfg(test)]
        test_pause(organization, channel, "snapshot", Some(target)).await;
        let authorizations: Vec<_> = captured
            .iter()
            .map(|(e, epoch)| Authorization::new(e.clone(), *epoch, None, false, None))
            .collect();
        let entries: Vec<_> = captured.iter().map(|(e, _)| e.clone()).collect();
        // The transaction snapshot proved prior access. Current live identity authorizes only this transition.
        #[cfg(test)]
        test_pause(organization, channel, "revoked", Some(target)).await;
        let proofs = authorize_notices(pool, &entries, None).await?;
        for (authorization, proof) in authorizations.iter().zip(&proofs) {
            authorization.proved(proof);
        }
        for ((entry, epoch), proof) in captured.iter().zip(proofs) {
            if let Some(proof) = proof {
                enqueue(
                    entry,
                    Pending {
                        notice: Notice::ChannelAccessRevoked {
                            channel_id: channel,
                        },
                        epoch: *epoch,
                        directory_epoch: None,
                        proof: Some(proof),
                    },
                );
            }
        }
        Ok(())
    }
}

impl Activity {
    pub(crate) async fn check(&self, pool: &sqlx::PgPool, scope: auth::SubscriptionScope) {
        let entries: Vec<_> = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
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
        let mut organizations = std::collections::BTreeMap::<_, Vec<_>>::new();
        for entry in entries {
            let b = entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
            for (channel, proof) in b
                .proofs
                .iter()
                .map(|(channel, proof)| (*channel, Some(proof.clone())))
                .chain(b.in_flight.values().cloned())
            {
                organizations.entry(entry.organization).or_default().push((
                    (entry.clone(), channel),
                    b.epoch,
                    proof,
                ));
            }
        }
        for rows in organizations.values() {
            for chunk in rows.chunks(1000) {
                let selected: Vec<_> = chunk
                    .iter()
                    .map(|(selected, _, _)| selected.clone())
                    .collect();
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
                let result = authorize_batch(pool, &selected).await;
                for (index, ((entry, _), epoch, proof)) in chunk.iter().enumerate() {
                    let current = result.as_ref().ok().and_then(|rows| rows[index].as_ref());
                    // An unproved snapshot cannot establish the in-flight grant's lifetime.
                    if proof.as_ref().is_some_and(|proof| current == Some(proof)) {
                        continue;
                    }
                    let mut b = entry.buffer.lock().unwrap_or_else(|e| e.into_inner());
                    if b.epoch == *epoch {
                        b.epoch = b.epoch.wrapping_add(1);
                        b.pending.clear();
                        b.proofs.clear();
                        b.in_flight.clear();
                        b.reset = false;
                    }
                }
            }
        }
    }
}

struct BatchLease {
    batches: Arc<Mutex<HashMap<(Uuid, Uuid), Senders>>>,
    key: (Uuid, Uuid),
    finished: bool,
}
impl Drop for BatchLease {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        self.batches
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

#[cfg(test)]
pub(crate) struct TestGate {
    member: Option<Uuid>,
    pub entered: Semaphore,
    pub release: Semaphore,
}
#[cfg(test)]
type TestGates = Mutex<HashMap<(Uuid, Uuid, &'static str), Arc<TestGate>>>;
#[cfg(test)]
static TEST_GATES: std::sync::LazyLock<TestGates> = std::sync::LazyLock::new(Mutex::default);
#[cfg(test)]
pub(crate) fn pause(organization: Uuid, channel: Uuid, phase: &'static str) -> Arc<TestGate> {
    pause_member(organization, channel, phase, None)
}
#[cfg(test)]
pub(crate) fn pause_member(
    organization: Uuid,
    channel: Uuid,
    phase: &'static str,
    member: Option<Uuid>,
) -> Arc<TestGate> {
    let gate = Arc::new(TestGate {
        member,
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
    });
    TEST_GATES
        .lock()
        .unwrap()
        .insert((organization, channel, phase), gate.clone());
    gate
}
#[cfg(test)]
async fn test_pause(organization: Uuid, channel: Uuid, phase: &'static str, member: Option<Uuid>) {
    let gate = {
        let mut gates = TEST_GATES.lock().unwrap();
        let key = (organization, channel, phase);
        if gates
            .get(&key)
            .is_some_and(|gate| gate.member.is_none() || gate.member == member)
        {
            gates.remove(&key)
        } else {
            None
        }
    };
    if let Some(gate) = gate {
        gate.entered.add_permits(1);
        gate.release.acquire().await.unwrap().forget();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn entry() -> Arc<Entry> {
        Arc::new(Entry {
            id: Uuid::new_v4(),
            organization: Uuid::new_v4(),
            member: (Uuid::new_v4(), 0),
            hash: vec![],
            buffer: Default::default(),
            wake: Notify::new(),
        })
    }
    fn pending(channel: Uuid, topic: Option<Uuid>) -> Pending {
        Pending {
            notice: Notice::ReadPositionChanged {
                channel_id: channel,
                topic_id: topic,
                read_seq: 10,
            },
            epoch: 0,
            directory_epoch: None,
            proof: Some(Proof {
                role: Role::Member,
                grant: None,
            }),
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
            epoch: 0,
            directory_epoch: None,
            event: Notice::MembersChanged,
        };
        entry.buffer.lock().unwrap().epoch = 2;
        let polled = std::sync::atomic::AtomicBool::new(false);
        assert_eq!(
            frame
                .handoff(async {
                    polled.store(true, std::sync::atomic::Ordering::SeqCst);
                })
                .await,
            None
        );
        assert!(!polled.load(std::sync::atomic::Ordering::SeqCst));
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
            let mut senders = Senders::default();
            for (sender, seq) in rows {
                senders.add(sender, seq);
            }
            assert_eq!(senders.eligible(alice), Some(2));
            assert_eq!(senders.eligible(bob), Some(3));
            assert_eq!(senders.eligible(third), Some(3));
            assert!(senders.0.len() <= 2);
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
    pub(crate) fn cancel(&self, organization: Uuid, channel: Uuid) {
        self.tasks
            .lock()
            .unwrap()
            .remove(&(organization, channel))
            .unwrap()
            .abort();
    }
}
