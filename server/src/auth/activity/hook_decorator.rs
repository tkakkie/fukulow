//! Delegates auth hooks while tests observe or control specific call sites.

use super::{ActivityChange, ActivityChanges, Capture, ChangeScope, ChannelChange};
use crate::auth::{SubscriptionRecheck, SubscriptionScope};
use futures_util::future::BoxFuture;
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

pub(crate) struct Decorator<T, H> {
    pub(crate) inner: T,
    pub(crate) hooks: H,
}

type BeforeChannel = Box<dyn Fn(&ChannelChange) + Send + Sync>;
type AfterCapture = Box<dyn Fn(ChangeScope) -> Option<ChangeHooks> + Send + Sync>;

#[derive(Default)]
pub(crate) struct ActivityHooks {
    pub(crate) before_channel: Option<BeforeChannel>,
    pub(crate) after_capture: Option<AfterCapture>,
}

impl<T: ActivityChanges> ActivityChanges for Decorator<T, ActivityHooks> {
    fn channel(&self, pool: PgPool, organization: Uuid, change: ChannelChange) {
        if let Some(before) = &self.hooks.before_channel {
            before(&change);
        }
        self.inner.channel(pool, organization, change);
    }

    fn capture<'a>(
        &'a self,
        connection: &'a mut PgConnection,
        organization: Uuid,
        target: Uuid,
        scope: ChangeScope,
    ) -> Capture<'a> {
        Box::pin(async move {
            let change = self
                .inner
                .capture(connection, organization, target, scope)
                .await?;
            let Some(hooks) = self
                .hooks
                .after_capture
                .as_ref()
                .and_then(|after| after(scope))
            else {
                return Ok(change);
            };
            Ok(Box::new(Decorator {
                inner: change,
                hooks,
            }) as Box<dyn ActivityChange>)
        })
    }

    fn directory(&self, pool: PgPool, organization: Uuid, target: Uuid) {
        self.inner.directory(pool, organization, target);
    }
}

type Commit = Box<dyn FnOnce(Box<dyn ActivityChange>, PgPool) + Send>;

pub(crate) struct ChangeHooks {
    pub(crate) skip_retire: bool,
    pub(crate) commit: Commit,
}

impl ActivityChange for Decorator<Box<dyn ActivityChange>, ChangeHooks> {
    fn retire(&mut self) {
        if !self.hooks.skip_retire {
            self.inner.retire();
        }
    }

    fn committed(self: Box<Self>, pool: PgPool) {
        (self.hooks.commit)(self.inner, pool);
    }
}

pub(crate) enum BeforeRecheck {
    Run,
    Wait(BoxFuture<'static, ()>),
    Skip,
}

type Recheck = Result<(), sqlx::Error>;
type BeforeRecheckHook = Box<dyn Fn(SubscriptionScope) -> BeforeRecheck + Send + Sync>;
type AfterRecheck = Box<dyn Fn(&Recheck) + Send + Sync>;

#[derive(Default)]
pub(crate) struct RecheckHooks {
    // Runs when check is called. The recheck hooks run when its future is polled.
    pub(crate) on_check: Option<Box<dyn Fn() + Send + Sync>>,
    pub(crate) before_recheck: Option<BeforeRecheckHook>,
    pub(crate) after_recheck: Option<AfterRecheck>,
    pub(crate) on_failed: Option<Box<dyn Fn() + Send + Sync>>,
}

impl<T: SubscriptionRecheck> SubscriptionRecheck for Decorator<T, RecheckHooks> {
    fn check<'a>(&'a self, pool: &'a PgPool, scope: SubscriptionScope) -> BoxFuture<'a, Recheck> {
        if let Some(on_check) = &self.hooks.on_check {
            on_check();
        }
        Box::pin(async move {
            if let Some(before) = &self.hooks.before_recheck {
                match before(scope) {
                    BeforeRecheck::Run => {}
                    BeforeRecheck::Wait(wait) => wait.await,
                    BeforeRecheck::Skip => return Ok(()),
                }
            }
            let result = self.inner.check(pool, scope).await;
            if let Some(after) = &self.hooks.after_recheck {
                after(&result);
            }
            result
        })
    }

    fn failed(&self, scope: SubscriptionScope) {
        match &self.hooks.on_failed {
            Some(on_failed) => on_failed(),
            None => self.inner.failed(scope),
        }
    }
}
