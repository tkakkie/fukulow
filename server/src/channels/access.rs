use super::*;
use crate::lock_ignoring_poison;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::watch;

type Registry = Arc<Mutex<Entries>>;
#[derive(Default)]
struct Entries {
    entries: HashMap<Uuid, Arc<Entry>>,
    by_channel: HashMap<(Uuid, Uuid), HashSet<Uuid>>,
    by_member: HashMap<(Uuid, Uuid), HashSet<Uuid>>,
}
impl Entries {
    fn snapshot(&self, scope: auth::SubscriptionScope) -> Vec<Arc<Entry>> {
        let ids = match scope {
            auth::SubscriptionScope::All => None,
            auth::SubscriptionScope::Channel(org, channel) => {
                Some(self.by_channel.get(&(org, channel)))
            }
            auth::SubscriptionScope::Member(org, member) => {
                Some(self.by_member.get(&(org, member)))
            }
        };
        match ids {
            None => self.entries.values().cloned().collect(),
            Some(ids) => ids
                .into_iter()
                .flatten()
                .filter_map(|id| self.entries.get(id).cloned())
                .collect(),
        }
    }
    fn insert(&mut self, id: Uuid, entry: Arc<Entry>) {
        self.by_channel
            .entry((entry.organization, entry.channel))
            .or_default()
            .insert(id);
        self.by_member
            .entry((entry.organization, entry.member.0))
            .or_default()
            .insert(id);
        self.entries.insert(id, entry);
    }
    fn remove(&mut self, id: &Uuid) {
        if let Some(entry) = self.entries.remove(id) {
            for (index, key) in [
                (&mut self.by_channel, (entry.organization, entry.channel)),
                (&mut self.by_member, (entry.organization, entry.member.0)),
            ] {
                if let Some(ids) = index.get_mut(&key) {
                    ids.remove(id);
                    if ids.is_empty() {
                        index.remove(&key);
                    }
                }
            }
        }
    }
}
#[derive(Default, Clone)]
pub struct AccessChanges {
    entries: Registry,
    pub(crate) activity: super::activity::Activity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AccessStatus {
    Active,
    ChannelLost,
    RecheckFailed,
    MembershipLost,
}

struct Entry {
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
    grant: Mutex<Option<Uuid>>,
    status: watch::Sender<AccessStatus>,
}

pub(crate) struct AccessWatch {
    id: Uuid,
    registry: Weak<Mutex<Entries>>,
    entry: Arc<Entry>,
    activity: super::activity::Activity,
    pub changed: watch::Receiver<AccessStatus>,
}
impl Drop for AccessWatch {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            lock_ignoring_poison(&registry).remove(&self.id);
        }
    }
}
impl AccessWatch {
    // Expose the status patterns through the existing AccessWatch re-export.
    pub(crate) const ACTIVE: AccessStatus = AccessStatus::Active;
    pub(crate) const CHANNEL_LOST: AccessStatus = AccessStatus::ChannelLost;
    pub(crate) const RECHECK_FAILED: AccessStatus = AccessStatus::RecheckFailed;
    pub(crate) const MEMBERSHIP_LOST: AccessStatus = AccessStatus::MembershipLost;

    pub async fn handoff<F: std::future::Future>(&self, future: F) -> Option<F::Output> {
        let mut future = std::pin::pin!(future);
        // The watch read guard excludes loss observation only through the first
        // poll (frame handoff). A pending write is then the in-flight exception.
        let first = std::future::poll_fn(|cx| {
            let status = self.entry.status.borrow();
            std::task::Poll::Ready(if *status == AccessStatus::Active {
                Some(std::future::Future::poll(future.as_mut(), cx))
            } else {
                None
            })
        })
        .await?;
        Some(match first {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => future.await,
        })
    }
    pub fn status(&self) -> AccessStatus {
        *self.entry.status.borrow()
    }
    pub async fn refresh(&self, pool: &sqlx::PgPool) -> Result<(), sqlx::Error> {
        check_entries(pool, std::slice::from_ref(&self.entry), &self.activity).await
    }
}
impl AccessChanges {
    pub(crate) async fn subscribe(
        &self,
        pool: &sqlx::PgPool,
        organization: Uuid,
        member: (Uuid, i64),
        channel: Uuid,
    ) -> Result<Option<AccessWatch>, sqlx::Error> {
        let initial = Arc::new(Entry {
            organization,
            member,
            channel,
            grant: Mutex::new(None),
            status: watch::channel(AccessStatus::Active).0,
        });
        let rows = access_rows(pool, std::slice::from_ref(&initial)).await?;
        let Some((true, grant, _)) = rows.into_iter().next() else {
            return Ok(None);
        };
        let entry = Arc::new(Entry {
            grant: Mutex::new(grant),
            organization,
            member,
            channel,
            status: watch::channel(AccessStatus::Active).0,
        });
        let id = Uuid::new_v4();
        let changed = entry.status.subscribe();
        lock_ignoring_poison(&self.entries).insert(id, entry.clone());
        let result = AccessWatch {
            id,
            registry: Arc::downgrade(&self.entries),
            entry,
            activity: self.activity.clone(),
            changed,
        };
        // Register, then check the captured lifetime again: removal on either
        // side of registration cannot escape both the fast signal and this read.
        result.refresh(pool).await?;
        Ok(Some(result))
    }
    pub(crate) fn observe_loss(&self, organization: Uuid, channel: Uuid, member: (Uuid, i64)) {
        self.activity.retire(organization, member.0);
        for entry in lock_ignoring_poison(&self.entries)
            .snapshot(auth::SubscriptionScope::Channel(organization, channel))
        {
            if entry.organization == organization
                && entry.channel == channel
                && entry.member == member
            {
                entry.status.send_if_modified(|status| {
                    if *status == AccessStatus::Active {
                        *status = AccessStatus::ChannelLost;
                        true
                    } else {
                        false
                    }
                });
            }
        }
    }
}
impl auth::SubscriptionRecheck for AccessChanges {
    fn check<'a>(
        &'a self,
        pool: &'a sqlx::PgPool,
        scope: auth::SubscriptionScope,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>>
    {
        let entries: Vec<_> = lock_ignoring_poison(&self.entries)
            .snapshot(scope)
            .into_iter()
            .filter(|e| *e.status.borrow() == AccessStatus::Active)
            .collect();
        Box::pin(async move {
            self.activity.check(pool, scope).await;
            check_entries(pool, &entries, &self.activity).await
        })
    }
    fn failed(&self, scope: auth::SubscriptionScope) {
        for entry in lock_ignoring_poison(&self.entries).snapshot(scope) {
            entry.status.send_if_modified(|status| {
                if *status == AccessStatus::Active {
                    *status = AccessStatus::RecheckFailed;
                    true
                } else {
                    false
                }
            });
        }
    }
}

async fn check_entries(
    pool: &sqlx::PgPool,
    entries: &[Arc<Entry>],
    activity: &super::activity::Activity,
) -> Result<(), sqlx::Error> {
    let rows = access_rows(pool, entries).await?;
    for (entry, (visible, grant, current)) in entries.iter().zip(rows) {
        // A public shortcut is continuous without its redundant grant. A
        // subscription originally dependent on a grant retains its lifetime.
        let mut captured = lock_ignoring_poison(&entry.grant);
        let lost = !visible || (captured.is_some() && grant.is_some() && *captured != grant);
        if !current {
            activity.retire_membership(entry.organization, entry.member);
        } else if lost {
            activity.retire(entry.organization, entry.member.0);
        }
        if !current {
            entry.status.send_if_modified(|status| {
                // An in-flight recheck can observe Membership loss after Channel
                // loss. A latched recheck failure keeps its close classification.
                if matches!(*status, AccessStatus::Active | AccessStatus::ChannelLost) {
                    *status = AccessStatus::MembershipLost;
                    true
                } else {
                    false
                }
            });
        } else if lost {
            entry.status.send_if_modified(|status| {
                if *status == AccessStatus::Active {
                    *status = AccessStatus::ChannelLost;
                    true
                } else {
                    false
                }
            });
        } else {
            *captured = grant;
        }
    }
    Ok(())
}
async fn access_rows(
    pool: &sqlx::PgPool,
    entries: &[Arc<Entry>],
) -> Result<Vec<(bool, Option<Uuid>, bool)>, sqlx::Error> {
    let mut groups = std::collections::BTreeMap::<_, Vec<_>>::new();
    for (index, entry) in entries.iter().enumerate() {
        groups
            .entry(entry.organization)
            .or_default()
            .push((index, entry));
    }
    let sql = access_rows_sql();
    let mut rows = vec![(false, None, false); entries.len()];
    for (organization, group) in groups {
        let selected: Vec<_> = group.iter().map(|(_, entry)| (*entry).clone()).collect();
        let scoped = if selected.len() <= 1000 {
            crate::database::organization_statement(
                pool,
                &sql,
                async |connection: &mut sqlx::PgConnection, sql: &str| {
                    let sql = format!("{sql} ORDER BY n");
                    access_rows_in(connection, &selected, &sql).await
                },
            )
            .await?
        } else {
            crate::database::organization_read_only(
                pool,
                organization,
                async |tx: &mut sqlx::PgConnection| {
                    let mut rows = Vec::with_capacity(selected.len());
                    for batch in selected.chunks(1000) {
                        rows.extend(access_rows_in(tx, batch, &sql).await?);
                    }
                    Ok::<_, sqlx::Error>(rows)
                },
            )
            .await?
        };
        for ((index, _), row) in group.into_iter().zip(scoped) {
            rows[index] = row;
        }
    }
    Ok(rows)
}

// OFFSET 0 retains the correlated candidate bounds even when the statement
// context makes RLS estimates tiny under a cached Generic plan.
fn access_rows_sql() -> String {
    let public_roles = auth::authorization::channel_roles_sql(false);
    let explicit_roles = auth::authorization::channel_roles_sql(true);
    format!("SELECT COALESCE((c.kind='channel' AND c.visibility='public' AND u.role IN ({public_roles})) OR (u.role IN ({explicit_roles}) AND cm.grant_id IS NOT NULL AND (c.kind='channel' OR u.id IN(c.lower_member_id,c.higher_member_id))), false),
        CASE WHEN c.visibility='public' AND u.role IN ({public_roles}) THEN NULL ELSE cm.grant_id END, u.id IS NOT NULL, r.n
        FROM unnest($2::uuid[], $3::bigint[], $4::uuid[]) WITH ORDINALITY r(member_id,revision,channel_id,n)
        LEFT JOIN LATERAL ({} OFFSET 0) u ON true
        LEFT JOIN channels c ON c.organization_id=$1 AND c.id=r.channel_id AND u.id IS NOT NULL
        LEFT JOIN LATERAL (SELECT grant_id FROM channel_members WHERE organization_id=$1 AND channel_id=r.channel_id AND member_id=r.member_id AND membership_revision=r.revision AND u.id IS NOT NULL AND c.id IS NOT NULL OFFSET 0) cm ON true
        ORDER BY r.n", auth::candidate_member_sql("r.member_id", "r.revision"))
}

async fn access_rows_in(
    connection: &mut sqlx::PgConnection,
    entries: &[Arc<Entry>],
    sql: &str,
) -> Result<Vec<(bool, Option<Uuid>, bool)>, sqlx::Error> {
    use sqlx::Row;
    let Some(first) = entries.first() else {
        return Ok(Vec::new());
    };
    let rows = sqlx::query(sql)
        .bind(first.organization)
        .bind(entries.iter().map(|e| e.member.0).collect::<Vec<_>>())
        .bind(entries.iter().map(|e| e.member.1).collect::<Vec<_>>())
        .bind(entries.iter().map(|e| e.channel).collect::<Vec<_>>())
        .fetch_all(connection)
        .await?;
    rows.iter()
        .map(|row| Ok((row.try_get(0)?, row.try_get(1)?, row.try_get(2)?)))
        .collect()
}

/// One single-batch `access_rows` read (one-statement context path) for #314 tests.
#[cfg(test)]
pub(crate) async fn access_row_for_test(
    pool: &sqlx::PgPool,
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
) -> Result<(bool, Option<Uuid>, bool), sqlx::Error> {
    let entry = Arc::new(Entry {
        organization,
        member,
        channel,
        grant: Mutex::new(None),
        status: watch::channel(AccessStatus::Active).0,
    });
    access_rows(pool, &[entry])
        .await?
        .pop()
        .ok_or(sqlx::Error::RowNotFound)
}

#[cfg(test)]
mod regression;

#[cfg(test)]
mod tests {
    use super::*;

    // Export builders, rather than maintain another SQL copy in the plan harness.
    #[test]
    #[ignore = "used by load/hot-plans/fanout.ts on a throwaway dataset"]
    fn export_fanout_plan_sql() {
        let directory = std::path::PathBuf::from(std::env::var_os("FANOUT_SQL_DIR").unwrap());
        std::fs::create_dir_all(&directory).unwrap();
        for (name, sql) in [
            ("access_rows_batch", access_rows_sql()),
            (
                "access_rows_single",
                format!(
                    "{} ORDER BY n",
                    crate::database::organization_statement_sql(&access_rows_sql())
                ),
            ),
            (
                "member_access",
                crate::database::organization_statement_sql(&super::super::member_access_sql()),
            ),
            ("member_access_batch", super::super::member_access_in_sql()),
        ] {
            std::fs::write(directory.join(format!("{name}.sql")), sql).unwrap();
        }
    }
    #[tokio::test]
    async fn observed_loss_blocks_new_frame_handoff_but_allows_only_the_inflight_frame() {
        let entry = Arc::new(Entry {
            organization: Uuid::new_v4(),
            member: (Uuid::new_v4(), 0),
            channel: Uuid::new_v4(),
            grant: Mutex::new(None),
            status: watch::channel(AccessStatus::Active).0,
        });
        let watch = Arc::new(AccessWatch {
            id: Uuid::new_v4(),
            registry: Weak::new(),
            changed: entry.status.subscribe(),
            entry: entry.clone(),
            activity: Default::default(),
        });
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let started = entered.notified();
        let task = {
            let watch = watch.clone();
            let entered = entered.clone();
            let release = release.clone();
            tokio::spawn(async move {
                watch
                    .handoff(async {
                        entered.notify_one();
                        release.notified().await;
                        7
                    })
                    .await
            })
        };
        started.await;
        entry.status.send_replace(AccessStatus::ChannelLost);
        release.notify_one();
        assert_eq!(task.await.unwrap(), Some(7));
        let polled = std::sync::atomic::AtomicBool::new(false);
        assert_eq!(
            watch
                .handoff(async {
                    polled.store(true, std::sync::atomic::Ordering::SeqCst);
                    9
                })
                .await,
            None
        );
        assert!(!polled.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[fukulow_test::test]
    async fn mixed_organization_access_rows_keep_input_order(pool: sqlx::PgPool) {
        let pools = crate::test_support::TestPools::new(pool).await;
        let mut organizations = [Uuid::new_v4(), Uuid::new_v4()];
        organizations.sort();
        let member = Uuid::new_v4();
        let channel = Uuid::new_v4();
        for (index, organization) in organizations.iter().enumerate() {
            let account = Uuid::new_v4();
            sqlx::query("INSERT INTO organizations (organization_id,name) VALUES ($1,'Context')")
                .bind(organization)
                .execute(&pools.admin)
                .await
                .unwrap();
            sqlx::query("INSERT INTO accounts (id,email,password_hash) VALUES ($1,$2,'unused')")
                .bind(account)
                .bind(format!("{account}@example.com"))
                .execute(&pools.admin)
                .await
                .unwrap();
            sqlx::query("INSERT INTO users (organization_id,id,account_id,name,role) VALUES ($1,$2,$3,'Member','member')")
                .bind(organization).bind(member).bind(account).execute(&pools.admin).await.unwrap();
            sqlx::query("INSERT INTO channels (organization_id,id,name,visibility) VALUES ($1,$2,'Channel',$3)")
                .bind(organization).bind(channel).bind(if index == 0 {"private"} else {"public"})
                .execute(&pools.admin).await.unwrap();
        }
        crate::database::test_support::context_policies(&pools.admin).await;
        let entry = |organization, revision| {
            Arc::new(Entry {
                organization,
                member: (member, revision),
                channel,
                grant: Mutex::new(None),
                status: watch::channel(AccessStatus::Active).0,
            })
        };
        // Both Organizations span several query chunks, interleaved in reverse
        // Organization order with stale epochs and different visibility results.
        let entries: Vec<_> = (0..2001)
            .flat_map(|_| {
                [
                    entry(organizations[1], 0),
                    entry(organizations[0], 0),
                    entry(organizations[1], 1),
                ]
            })
            .collect();
        let (counted, transactions) = crate::database::test_support::counted_pool(&pools.app).await;
        assert_eq!(
            access_rows(&counted, &entries).await.unwrap(),
            [
                (true, None, true),
                (false, None, true),
                (false, None, false),
            ]
            .repeat(2001)
        );
        use std::sync::atomic::Ordering;
        assert_eq!(transactions.swap(0, Ordering::SeqCst), organizations.len());
        check_entries(&counted, &entries, &Default::default())
            .await
            .unwrap();
        assert_eq!(transactions.load(Ordering::SeqCst), organizations.len());
        assert_eq!(
            entries
                .iter()
                .map(|e| *e.status.borrow())
                .collect::<Vec<_>>(),
            [
                AccessStatus::Active,
                AccessStatus::ChannelLost,
                AccessStatus::MembershipLost,
            ]
            .repeat(2001)
        );
        counted.close().await;
        pools.app.close().await;
    }
}
