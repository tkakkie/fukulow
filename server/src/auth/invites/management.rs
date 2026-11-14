use super::*;
use axum::extract::Query;
use utoipa::IntoParams;

#[derive(Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct OutstandingInvite {
    pub id: Uuid,
    pub email: String,
    pub role: Role,
    /// Same-Organization issuer Member id, including inactive issuers.
    pub created_by: Uuid,
    pub expires_at: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct InvitePage {
    pub invites: Vec<OutstandingInvite>,
    /// Opaque, Role- and Organization-bound continuation; omitted on the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Default, Deserialize, IntoParams)]
#[serde(deny_unknown_fields)]
pub struct ListInvitesQuery {
    /// Opaque continuation from the preceding page. Invalid/foreign cursors return 400.
    pub cursor: Option<String>,
}

#[utoipa::path(get, path="/api/v1/orgs/{org}/invites",
    params(("org"=Uuid, Path, description="Organization id"), ListInvitesQuery),
    security(("cookie"=[]),("bearer"=[])),
    responses((status=200, description="Outstanding manageable Invites, ordered by creation time then id; up to 100, never tokens. Admin pages exclude Owner-Role Invites before filling", body=InvitePage),
    (status=400, description="Malformed or foreign cursor or invalid input", body=ErrorBody),
    (status=401, description="Account Session ended", body=ErrorBody),
    (status=403, description="forbidden: Member/Guest cannot manage Invites", body=ErrorBody),
    (status=404, description="organization_unavailable", body=ErrorBody),
    (status=500, description="Database failure", body=ErrorBody)))]
pub async fn list_invites(
    State(state): State<AppState>,
    auth: Auth,
    query: Result<Query<ListInvitesQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(|_| ApiError::bad_request())?;
    let org = auth.identity.organization.organization_id;
    let page = crate::database::organization(&state.pool, org, async |tx: &mut sqlx::PgConnection| {
        members::lock_organization(tx, org).await?;
        let actor = members::current_actor(tx, &auth, Action::Invite(Role::Member)).await?;
        let owner = authorize(actor, Action::Invite(Role::Owner), Resource::Organization(org)).allowed;
        // Column choice is server-controlled and comes only from fresh authorization.
        let cursor_column = if owner { "owner_cursor" } else { "admin_cursor" };
        let anchor = if let Some(cursor) = query.cursor {
            let cursor = Uuid::parse_str(&cursor).map_err(|_| ApiError::bad_request())?;
            // Do not require the anchor to remain outstanding: acceptance, revocation
            // and expiry must not invalidate a boundary or shift subsequent pages.
            let sql = format!("SELECT id FROM invites WHERE organization_id=$1 AND {cursor_column}=$2 AND ($3 OR role<>'owner')");
            Some(sqlx::query_scalar::<_, Uuid>(&sql).bind(org).bind(cursor).bind(owner)
                .fetch_optional(&mut *tx).await?.ok_or_else(ApiError::bad_request)?)
        } else { None };
        let sql =
            "SELECT id,email,role,created_by,to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS expires_at FROM invites \
             WHERE organization_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() \
             AND ($2 OR role<>'owner') AND ($3::uuid IS NULL OR (created_at,id) > \
             (SELECT created_at,id FROM invites WHERE organization_id=$1 AND id=$3)) ORDER BY created_at,id LIMIT 101";
        let mut invites: Vec<OutstandingInvite> = sqlx::query_as(sql).bind(org).bind(owner).bind(anchor).fetch_all(&mut *tx).await?;
        let next_cursor = if invites.len() > 100 {
            invites.truncate(100);
            let last = invites.last().ok_or_else(ApiError::bad_request)?;
            let sql = format!("SELECT {cursor_column} FROM invites WHERE organization_id=$1 AND id=$2");
            let cursor: Uuid = sqlx::query_scalar(&sql).bind(org).bind(last.id).fetch_one(&mut *tx).await?;
            Some(cursor.to_string())
        } else { None };
        Ok::<_, ApiError>(InvitePage { invites, next_cursor })
    }).await?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(page)).into_response())
}

#[utoipa::path(delete, path="/api/v1/orgs/{org}/invites/{id}",
    params(("org"=Uuid, Path, description="Organization id"), ("id"=Uuid, Path, description="Invite id")),
    security(("cookie"=[]),("bearer"=[])),
    responses((status=204, description="Outstanding manageable Invite permanently revoked; empty body"),
    (status=400, description="Invalid ids", body=ErrorBody),
    (status=401, description="Account Session ended", body=ErrorBody),
    (status=403, description="forbidden: Member/Guest cannot manage Invites", body=ErrorBody),
    (status=404, description="organization_unavailable; otherwise uniform invite_unavailable for accepted, revoked, expired, unknown, foreign or not-manageable Invites", body=ErrorBody),
    (status=500, description="Database failure", body=ErrorBody)))]
pub async fn revoke_invite(
    State(state): State<AppState>,
    auth: Auth,
    path: Result<Path<(Uuid, Uuid)>, axum::extract::rejection::PathRejection>,
) -> Result<Response, ApiError> {
    let Path((org, id)) = path.map_err(|_| ApiError::bad_request())?;
    crate::database::organization(&state.pool, org, async |tx: &mut sqlx::PgConnection| {
        members::lock_organization(tx, org).await?;
        let actor = members::current_actor(tx, &auth, Action::Invite(Role::Member)).await?;
        let role: Role = sqlx::query_scalar("SELECT role FROM invites WHERE organization_id=$1 AND id=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE")
            .bind(org).bind(id).fetch_optional(&mut *tx).await?.ok_or_else(invalid_invite)?;
        authorization::require(actor, Action::Invite(role), Resource::Organization(org)).map_err(|_| invalid_invite())?;
        let changed = sqlx::query("UPDATE invites SET revoked_at=clock_timestamp() WHERE organization_id=$1 AND id=$2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()")
            .bind(org).bind(id).execute(&mut *tx).await?.rows_affected();
        if changed != 1 { return Err(invalid_invite()); }
        Ok::<_, ApiError>(())
    }).await?;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::CACHE_CONTROL, "no-store")],
    )
        .into_response())
}
