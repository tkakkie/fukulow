//! Organization notices are invalidations, never Message delivery or authorization grants.
use super::*;
use crate::lock_ignoring_poison;
use crate::observability::notice_permits::NoticeCaller;
use auth::activity::ChangeScope;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak, atomic::Ordering},
    time::Duration,
};
#[cfg(test)]
use std::{collections::HashSet, sync::atomic::AtomicBool};
use tokio::{
    sync::{Notify, Semaphore},
    time::Instant,
};
mod authorize;
mod buffer;
mod dms;
mod fallback_trace;
mod handoff;
mod holds;
mod notice_budget;
mod publish;
mod recheck;
mod revocations;
mod target_change;
#[cfg(test)]
mod test_hooks;
use authorize::Authorization;
#[cfg(test)]
use authorize::{authorize_batch, directory_guests};
use buffer::{Buffer, Epoch, Pending, enqueue};
#[cfg(test)]
use buffer::{Proof, QueryToken};
pub(crate) use dms::DmPublication;
pub(crate) use handoff::NoticeFrame;
pub(crate) use holds::revocation_hold_counts;
use notice_budget::NoticeBudget;
#[cfg(test)]
use notice_budget::notice_query_slot;
use publish::ActivityBatch;
pub(crate) use publish::PublicationFence;
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
    fn snapshot(
        &self,
        organization: Uuid,
        epochs: Option<&HashMap<Uuid, u64>>,
    ) -> Vec<(Arc<Entry>, u64)> {
        lock_ignoring_poison(&self.entries)
            .values()
            .filter_map(|e| {
                if e.organization != organization {
                    return None;
                }
                let b = lock_ignoring_poison(&e.buffer);
                let epoch = b.epoch;
                epochs
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
            .snapshot(organization, None)
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
        let activity = Activity::default();
        let old = entry();
        let mut replacement = entry();
        Arc::get_mut(&mut replacement).unwrap().organization = old.organization;
        Arc::get_mut(&mut replacement).unwrap().member = old.member;
        let epochs = HashMap::from([(old.id, 0)]);
        activity
            .entries
            .lock()
            .unwrap()
            .insert(replacement.id, replacement);
        assert!(
            activity
                .snapshot(old.organization, Some(&epochs))
                .is_empty()
        );
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
