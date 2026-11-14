use super::*;
use crate::auth::members::{DisplayIdentity, display_identities};

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AuthorLookupRequest {
    /// At most 100 input ids, including duplicates. Duplicates are collapsed.
    #[schema(max_items = 100)]
    pub ids: Vec<Uuid>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AuthorIdentities {
    /// Only authors of currently readable Messages; omitted ids remain unresolved.
    pub identities: Vec<DisplayIdentity>,
}

/// Resolve historical authors without widening the active Member directory.
/// Authorization, authorship and identities share a non-locking REPEATABLE READ snapshot.
#[utoipa::path(post, path = "/api/v1/orgs/{org}/message-authors", request_body = AuthorLookupRequest,
    params(("org" = Uuid, Path, description = "Organization id")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Distinct display identities for authors of Messages the caller can currently read, including deactivated authors and authors who left; all other ids omitted", body = AuthorIdentities),
        (status = 400, description = "Invalid input or more than 100 ids (before deduplication)", body = ErrorBody),
        (status = 401, description = "Account Session ended", body = ErrorBody),
        (status = 404, description = "organization_unavailable", body = ErrorBody),
        (status = 413, description = "Request too large", body = ErrorBody),
        (status = 415, description = "Expected application/json", body = ErrorBody),
        (status = 500, description = "Database failure", body = ErrorBody)))]
pub async fn lookup_authors(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(input): ApiJson<AuthorLookupRequest>,
) -> Result<Response, ApiError> {
    if input.ids.len() > 100 {
        return Err(ApiError::bad_request());
    }
    let organization = auth.identity.organization.organization_id;
    crate::database::organization_read_only(&state.pool, organization, async |tx: &mut sqlx::PgConnection| {
        let channels = channels::visible_list(&mut *tx, &auth).await?;
        let channels: Vec<_> = channels.into_iter().map(|channel| channel.id).collect();
        #[cfg(test)]
        super::tests::authors::pause(organization).await;
        let authors: Vec<Uuid> = sqlx::query_scalar(
            "SELECT DISTINCT sender FROM messages WHERE organization_id=$1 AND sender=ANY($2) AND channel_id=ANY($3)",
        ).bind(organization).bind(&input.ids).bind(channels).fetch_all(&mut *tx).await?;
        let identities = display_identities(tx, organization, &authors).await?;
        Ok(([(header::CACHE_CONTROL, "no-store")], Json(AuthorIdentities { identities })).into_response())
    }).await
}
