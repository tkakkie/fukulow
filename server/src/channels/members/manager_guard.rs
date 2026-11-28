use axum::http::StatusCode;
use uuid::Uuid;

use crate::auth::{self, ApiError, Role};

pub(super) enum ManagerChange {
    RemoveGrant,
    RevokeRight,
    Role(Role),
    Deactivate,
}

pub(super) async fn protect(
    connection: &mut sqlx::PgConnection,
    org: Uuid,
    channels: &[Uuid],
    target: Uuid,
    change: ManagerChange,
) -> Result<(), ApiError> {
    let remove_grant = matches!(
        change,
        ManagerChange::RemoveGrant | ManagerChange::Deactivate
    );
    let role = if let ManagerChange::Role(role) = change {
        Some(role)
    } else {
        None
    };
    let revoke = matches!(
        change,
        ManagerChange::RevokeRight | ManagerChange::Role(Role::Guest)
    );
    let before = manager_sql("u.role", "cm.manager");
    let after = manager_sql(
        "(CASE WHEN u.id=$3 THEN COALESCE($4::text,u.role) ELSE u.role END)",
        "(cm.manager AND NOT (u.id=$3 AND $5))",
    );
    let sql = format!(
        "SELECT count(*) FILTER (WHERE {before}),count(*) FILTER (WHERE u.id<>$3),count(*) FILTER (WHERE (NOT $6 OR u.id<>$3) AND ({after})) FROM channel_members cm JOIN ({}) u ON u.organization_id=cm.organization_id AND u.id=cm.member_id AND u.membership_revision=cm.membership_revision WHERE cm.organization_id=$1 AND cm.channel_id=ANY($2) AND EXISTS(SELECT 1 FROM channels c WHERE c.organization_id=cm.organization_id AND c.id=cm.channel_id AND c.kind='channel') GROUP BY cm.channel_id",
        auth::members::ACTIVE_SCOPED_MEMBERS_SQL
    );
    let counts: Vec<(i64, i64, i64)> = sqlx::query_as(&sql)
        .bind(org)
        .bind(channels)
        .bind(target)
        .bind(role)
        .bind(revoke)
        .bind(remove_grant)
        .fetch_all(connection)
        .await?;
    for (managers, remaining, remaining_managers) in counts {
        if matches!(change, ManagerChange::RemoveGrant) && remaining == 0 {
            return Err(ApiError(StatusCode::CONFLICT, "last_channel_grant", None));
        }
        if managers > 0 && remaining_managers == 0 {
            return Err(ApiError(StatusCode::CONFLICT, "last_channel_manager", None));
        }
    }
    Ok(())
}

// SQL is a projection of authorize over all Roles and both right values.
// The guard substitutes the proposed Role/right; removal excludes the grant.
fn manager_sql(role: &str, right: &str) -> String {
    let without = auth::authorization::channel_manager_roles_sql(false);
    let with = auth::authorization::channel_manager_roles_sql(true);
    format!("((NOT {right} AND {role} IN ({without})) OR ({right} AND {role} IN ({with})))")
}

pub struct RoleChangeGuard(Vec<Uuid>);

impl auth::members::RoleChangeGuard for RoleChangeGuard {
    async fn check_deactivation(
        &self,
        connection: &mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
    ) -> Result<(), ApiError> {
        protect(
            connection,
            organization,
            &self.0,
            target,
            ManagerChange::Deactivate,
        )
        .await
    }

    async fn lock(
        connection: &mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
    ) -> Result<Self, ApiError> {
        // Private creation and grant mutations share Organization serialization;
        // lock before current_actor takes its Member lock, even for self changes.
        let channels = sqlx::query_scalar("SELECT c.id FROM channels c WHERE c.organization_id=$1 AND c.kind='channel' AND c.visibility='private' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.organization_id=c.organization_id AND cm.channel_id=c.id AND cm.member_id=$2) ORDER BY c.id FOR NO KEY UPDATE OF c")
            .bind(organization).bind(target).fetch_all(connection).await?;
        Ok(Self(channels))
    }

    async fn check(
        &self,
        connection: &mut sqlx::PgConnection,
        organization: Uuid,
        target: Uuid,
        role: Role,
    ) -> Result<(), ApiError> {
        auth::members::active_target(connection, organization, target)
            .await?
            .ok_or_else(ApiError::member_not_found)?;
        protect(
            connection,
            organization,
            &self.0,
            target,
            ManagerChange::Role(role),
        )
        .await?;
        if role == Role::Guest {
            sqlx::query("UPDATE channel_members SET manager=false WHERE organization_id=$1 AND member_id=$2 AND channel_id=ANY($3) AND manager")
                .bind(organization).bind(target).bind(&self.0).execute(connection).await?;
        }
        Ok(())
    }
}
