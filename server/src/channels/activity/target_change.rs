use super::{
    Activity, Notice, PublicationFence, Retirement,
    buffer::{Epoch, Pending, QueryToken, enqueue},
    dms,
    publish::ScopedNotice,
    revocations::Capture,
};
#[cfg(test)]
use super::{Entry, test_hooks::test_pause};
use crate::{
    auth::{self, Role, activity::ChangeScope},
    lock_ignoring_poison,
    observability::notice_permits::NoticeCaller,
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use uuid::Uuid;

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
    directory_epochs: Option<Arc<HashMap<Uuid, u64>>>,
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
                    ScopedNotice {
                        notice: Notice::ChannelListChanged,
                        channel: Some(channel),
                        target: None,
                    },
                    PublicationFence::default(),
                );
            }
            auth::activity::ChannelChange::Created {
                channel,
                creator,
                public,
            } => {
                self.spawn(
                    pool,
                    organization,
                    Notice::ChannelAccessGained {
                        channel_id: channel,
                    },
                    if public { None } else { Some(creator) },
                    PublicationFence {
                        exclude_guests: true,
                        ..PublicationFence::default()
                    },
                );
            }
            auth::activity::ChannelChange::Members { channel } => self.spawn(
                pool,
                organization,
                Notice::ChannelMembersChanged {
                    channel_id: channel,
                },
                None,
                PublicationFence::default(),
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
                .snapshot(organization, None)
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
                directory_epochs: None,
            }) as Box<dyn auth::activity::ActivityChange>)
        })
    }
    fn directory(&self, pool: sqlx::PgPool, organization: Uuid, target: Uuid) {
        self.spawn(
            pool,
            organization,
            Notice::MembersChanged,
            None,
            PublicationFence {
                directory_member: Some(target),
                ..PublicationFence::default()
            },
        );
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
        self.directory_epochs = Some(Arc::new(
            self.activity.advance_directory_epochs(self.organization),
        ));
    }
    fn committed(mut self: Box<Self>, pool: sqlx::PgPool) {
        self.retire();
        let fence = PublicationFence {
            epochs: Some(Arc::new(
                self.activity
                    .snapshot(self.organization, None)
                    .iter()
                    .map(|(entry, epoch)| (entry.id, *epoch))
                    .collect(),
            )),
            directory_epochs: self.directory_epochs.take(),
            ..PublicationFence::default()
        };
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
                        .publish_dm(&pool, self.organization, &self.dm_peers, fence.clone())
                        .await?;
                }
                if self.before.identity.is_none() {
                    self.activity
                        .publish(
                            &pool,
                            self.organization,
                            Notice::MembersChanged,
                            None,
                            None,
                            PublicationFence {
                                directory_member: Some(self.target),
                                ..fence.clone()
                            },
                        )
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
                                fence.clone(),
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
                            fence.clone(),
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
                                fence.clone(),
                            )
                            .await?;
                    }
                }
                if self.before.identity != after.identity || grants_changed {
                    self.activity
                        .publish(
                            &pool,
                            self.organization,
                            Notice::MembersChanged,
                            None,
                            None,
                            PublicationFence {
                                directory_member: Some(self.target),
                                directory_channels: before_grants
                                    .union(&after_grants)
                                    .copied()
                                    .collect(),
                                ..fence.clone()
                            },
                        )
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
                                fence.clone(),
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
        let proofs = self
            .authorize(pool, &selected, NoticeCaller::Revoked)
            .await?;
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

    #[cfg(test)]
    pub(super) async fn revoked_for_test(
        &self,
        pool: &sqlx::PgPool,
        entry: &Entry,
        channel: Uuid,
        mutation: Capture,
    ) -> Result<impl auth::activity::ActivityChange, sqlx::Error> {
        let change = TargetChange {
            activity: self.clone(),
            organization: entry.organization,
            target: entry.member.0,
            before: TargetState::default(),
            registrations: [(entry.id, mutation)].into(),
            channel: Some(channel),
            dm_peers: Vec::new(),
            retired: false,
            directory_epochs: None,
        };
        self.revoked(pool, &change, channel, false, Role::Member)
            .await?;
        Ok(change)
    }
}
