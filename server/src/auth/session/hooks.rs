//! Relays callbacks for activity notifications or subscription rechecks.

use super::{CHECK_TIMEOUT, SessionChanges};
use crate::{auth::activity, lock_ignoring_poison};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub enum SubscriptionScope {
    All,
    Channel(Uuid, Uuid),
    Member(Uuid, Uuid),
}

pub trait SubscriptionRecheck: Send + Sync {
    fn check<'a>(
        &'a self,
        pool: &'a PgPool,
        scope: SubscriptionScope,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>>;
    fn failed(&self, scope: SubscriptionScope);
}

#[derive(Clone, Default)]
pub(super) struct ActivityHook(Arc<Mutex<Option<activity::Hook>>>);

#[derive(Clone, Default)]
pub(super) struct SubscriptionHook(Arc<Mutex<Option<Arc<dyn SubscriptionRecheck>>>>);

impl SubscriptionHook {
    pub(super) fn current(&self) -> Option<Arc<dyn SubscriptionRecheck>> {
        lock_ignoring_poison(&self.0).clone()
    }
}

impl SessionChanges {
    pub(crate) fn set_activity(&self, hook: activity::Hook) {
        *lock_ignoring_poison(&self.activity.0) = Some(hook);
    }

    pub(crate) async fn capture_activity(
        &self,
        connection: &mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
        scope: activity::ChangeScope,
    ) -> Result<Option<Box<dyn activity::ActivityChange>>, sqlx::Error> {
        let hook = lock_ignoring_poison(&self.activity.0).clone();
        match hook {
            Some(hook) => hook
                .capture(connection, organization, target, scope)
                .await
                .map(Some),
            None => Ok(None),
        }
    }

    pub(crate) fn channel_changed(
        &self,
        pool: PgPool,
        organization: Uuid,
        change: activity::ChannelChange,
    ) {
        let hook = lock_ignoring_poison(&self.activity.0).clone();
        if let Some(hook) = hook {
            hook.channel(pool, organization, change);
        }
    }

    pub(crate) fn directory_changed(&self, pool: PgPool, organization: Uuid, target: Uuid) {
        let hook = lock_ignoring_poison(&self.activity.0).clone();
        if let Some(hook) = hook {
            hook.directory(pool, organization, target);
        }
    }

    pub fn set_subscription_recheck(&self, check: Arc<dyn SubscriptionRecheck>) {
        *lock_ignoring_poison(&self.subscriptions.0) = Some(check);
    }

    pub(crate) async fn recheck_subscriptions(&self, pool: &PgPool, scope: SubscriptionScope) {
        let check = self.subscriptions.current();
        if let Some(check) = check
            && !matches!(
                tokio::time::timeout(CHECK_TIMEOUT, check.check(pool, scope)).await,
                Ok(Ok(()))
            )
        {
            check.failed(scope);
        }
    }
}
