use super::*;
use std::{future::Future, pin::Pin, sync::Arc};

pub type Capture<'a> =
    Pin<Box<dyn Future<Output = Result<Box<dyn ActivityChange>, sqlx::Error>> + Send + 'a>>;
pub enum ChannelChange {
    Created {
        channel: Uuid,
        creator: Uuid,
        public: bool,
    },
    Members {
        channel: Uuid,
    },
}
pub trait ActivityChanges: Send + Sync {
    fn channel(&self, pool: sqlx::PgPool, organization: Uuid, change: ChannelChange);
    fn capture<'a>(
        &'a self,
        connection: &'a mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
    ) -> Capture<'a>;
    fn directory(&self, pool: sqlx::PgPool, organization: Uuid, target: Uuid);
}
pub trait ActivityChange: Send {
    fn committed(self: Box<Self>, pool: sqlx::PgPool);
}
pub(crate) type Hook = Arc<dyn ActivityChanges>;

pub(crate) async fn notice_target(
    connection: &mut sqlx::PgConnection,
    organization: Uuid,
    target: Uuid,
) -> Result<Option<(Role, i64)>, sqlx::Error> {
    sqlx::query_as("SELECT role,membership_revision FROM users WHERE organization_id=$1 AND id=$2 AND deactivated_at IS NULL")
        .bind(organization).bind(target).fetch_optional(connection).await
}
