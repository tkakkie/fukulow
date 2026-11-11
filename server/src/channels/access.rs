use super::*;
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
}
struct Entry {
    organization: Uuid,
    member: (Uuid, i64),
    channel: Uuid,
    grant: Mutex<Option<Uuid>>,
    status: watch::Sender<u8>,
}

pub(crate) struct AccessWatch {
    id: Uuid,
    registry: Weak<Mutex<Entries>>,
    entry: Arc<Entry>,
    pub changed: watch::Receiver<u8>,
}
impl Drop for AccessWatch {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            registry
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.id);
        }
    }
}
impl AccessWatch {
    pub async fn handoff<F: std::future::Future>(&self, future: F) -> Option<F::Output> {
        let mut future = std::pin::pin!(future);
        // The watch read guard excludes loss observation only through the first
        // poll (frame handoff). A pending write is then the in-flight exception.
        let first = std::future::poll_fn(|cx| {
            let status = self.entry.status.borrow();
            std::task::Poll::Ready(if *status == 0 {
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
    pub fn status(&self) -> u8 {
        *self.entry.status.borrow()
    }
    pub async fn refresh(&self, pool: &sqlx::PgPool) -> Result<(), sqlx::Error> {
        check_entries(pool, std::slice::from_ref(&self.entry)).await
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
            status: watch::channel(0).0,
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
            status: watch::channel(0).0,
        });
        let id = Uuid::new_v4();
        let changed = entry.status.subscribe();
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, entry.clone());
        let result = AccessWatch {
            id,
            registry: Arc::downgrade(&self.entries),
            entry,
            changed,
        };
        // Register, then check the captured lifetime again: removal on either
        // side of registration cannot escape both the fast signal and this read.
        result.refresh(pool).await?;
        Ok(Some(result))
    }
    pub(crate) fn observe_loss(&self, organization: Uuid, channel: Uuid, member: (Uuid, i64)) {
        for entry in self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot(auth::SubscriptionScope::Channel(organization, channel))
        {
            if entry.organization == organization
                && entry.channel == channel
                && entry.member == member
            {
                entry.status.send_if_modified(|status| {
                    if *status == 0 {
                        *status = 1;
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
        let entries: Vec<_> = self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot(scope)
            .into_iter()
            .filter(|e| *e.status.borrow() == 0)
            .collect();
        Box::pin(async move { check_entries(pool, &entries).await })
    }
    fn failed(&self, scope: auth::SubscriptionScope) {
        for entry in self
            .entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot(scope)
        {
            entry.status.send_if_modified(|status| {
                if *status == 0 {
                    *status = 2;
                    true
                } else {
                    false
                }
            });
        }
    }
}

async fn check_entries(pool: &sqlx::PgPool, entries: &[Arc<Entry>]) -> Result<(), sqlx::Error> {
    for batch in entries.chunks(1000) {
        let rows = access_rows(pool, batch).await?;
        for (entry, (visible, grant, current)) in batch.iter().zip(rows) {
            // A public shortcut is continuous without its redundant grant. A
            // subscription originally dependent on a grant retains its lifetime.
            let mut captured = entry.grant.lock().unwrap_or_else(|e| e.into_inner());
            let lost = !visible || (captured.is_some() && grant.is_some() && *captured != grant);
            if !current {
                entry.status.send_if_modified(|status| {
                    if *status < 2 {
                        *status = 3;
                        true
                    } else {
                        false
                    }
                });
            } else if lost {
                entry.status.send_if_modified(|status| {
                    if *status == 0 {
                        *status = 1;
                        true
                    } else {
                        false
                    }
                });
            } else {
                *captured = grant;
            }
        }
    }
    Ok(())
}
async fn access_rows(
    pool: &sqlx::PgPool,
    entries: &[Arc<Entry>],
) -> Result<Vec<(bool, Option<Uuid>, bool)>, sqlx::Error> {
    let public_roles = auth::authorization::channel_roles_sql(false);
    let explicit_roles = auth::authorization::channel_roles_sql(true);
    let sql = format!("SELECT COALESCE((c.visibility='public' AND u.role IN ({public_roles})) OR (u.role IN ({explicit_roles}) AND cm.grant_id IS NOT NULL), false),
        CASE WHEN c.visibility='public' AND u.role IN ({public_roles}) THEN NULL ELSE cm.grant_id END, u.id IS NOT NULL
        FROM unnest($1::uuid[], $2::uuid[], $3::bigint[], $4::uuid[]) WITH ORDINALITY r(organization_id,member_id,revision,channel_id,n)
        LEFT JOIN ({}) u ON u.organization_id=r.organization_id AND u.id=r.member_id AND u.membership_revision=r.revision
        LEFT JOIN channels c ON c.organization_id=r.organization_id AND c.id=r.channel_id AND u.id IS NOT NULL
        LEFT JOIN channel_members cm ON cm.organization_id=c.organization_id AND cm.channel_id=c.id AND cm.member_id=u.id AND cm.membership_revision=u.membership_revision
        ORDER BY r.n", auth::members::ACTIVE_SCOPED_MEMBERS_SQL);
    sqlx::query_as(&sql)
        .bind(entries.iter().map(|e| e.organization).collect::<Vec<_>>())
        .bind(entries.iter().map(|e| e.member.0).collect::<Vec<_>>())
        .bind(entries.iter().map(|e| e.member.1).collect::<Vec<_>>())
        .bind(entries.iter().map(|e| e.channel).collect::<Vec<_>>())
        .fetch_all(pool)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn observed_loss_blocks_new_frame_handoff_but_allows_only_the_inflight_frame() {
        let entry = Arc::new(Entry {
            organization: Uuid::new_v4(),
            member: (Uuid::new_v4(), 0),
            channel: Uuid::new_v4(),
            grant: Mutex::new(None),
            status: watch::channel(0).0,
        });
        let watch = Arc::new(AccessWatch {
            id: Uuid::new_v4(),
            registry: Weak::new(),
            changed: entry.status.subscribe(),
            entry: entry.clone(),
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
        entry.status.send_replace(1);
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
}
