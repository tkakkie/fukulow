use super::*;
use axum::{
    Extension, Router,
    extract::{DefaultBodyLimit, FromRequestParts, RawPathParams},
    http::request::Parts,
    routing::{get, put},
};
use sqlx::PgConnection;
use std::collections::HashSet;

mod channels;
pub(crate) mod read;
pub(crate) mod write;

const MAX_SECTIONS: usize = 50;
const MAX_CHANNELS: usize = 20_000;

#[derive(Serialize, ToSchema)]
pub(crate) struct Section {
    id: Uuid,
    name: String,
    channel_ids: Vec<Uuid>,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct SectionLayout {
    /// Canonical unsigned decimal, at most 9223372036854775807.
    #[schema(pattern = "^(0|[1-9][0-9]*)$", max_length = 19)]
    generation: String,
    sections: Vec<Section>,
    other_channel_ids: Vec<Uuid>,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct SectionSnapshot {
    /// Canonical unsigned decimal, at most 9223372036854775807.
    #[schema(pattern = "^(0|[1-9][0-9]*)$", max_length = 19)]
    generation: String,
    section: Section,
}

#[derive(Serialize, ToSchema)]
pub(crate) struct ChannelPlacement {
    /// Canonical unsigned decimal, at most 9223372036854775807.
    #[schema(pattern = "^(0|[1-9][0-9]*)$", max_length = 19)]
    generation: String,
    #[schema(required = true)]
    section_id: Option<Uuid>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateSection {
    id: Uuid,
    #[schema(min_length = 1, max_length = 60)]
    name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct RenameSection {
    #[schema(min_length = 1, max_length = 60)]
    name: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct SectionOrder {
    #[schema(max_items = 50)]
    section_ids: Vec<Uuid>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct ChannelOrder {
    #[serde(deserialize_with = "required_section_id")]
    #[schema(required = true)]
    section_id: Option<Uuid>,
    #[schema(max_items = 20_000)]
    channel_ids: Vec<Uuid>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct MoveChannel {
    #[serde(deserialize_with = "required_section_id")]
    #[schema(required = true)]
    section_id: Option<Uuid>,
}

fn required_section_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Uuid>, D::Error> {
    Option::deserialize(deserializer)
}

#[derive(Serialize, ToSchema)]
pub(crate) struct CreatedSection {
    id: Uuid,
    /// Canonical unsigned decimal, at most 9223372036854775807.
    #[schema(pattern = "^(0|[1-9][0-9]*)$", max_length = 19)]
    generation: String,
}

#[derive(Clone, Copy)]
pub(crate) struct Owner {
    org: Uuid,
    member: Uuid,
    revision: i64,
}

impl FromRequestParts<AppState> for Owner {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let account = auth::AccountAuth::from_request_parts(parts, state).await?;
        // Axum decodes all path parameters together. Validate the Organization
        // separately so a malformed later segment cannot outrank Membership.
        let org = organization_id(parts.uri.path()).ok_or_else(ApiError::bad_request)?;
        let (member, revision) = account.active_membership(&state.pool, org).await?;
        if parts.uri.query().is_some() {
            return Err(ApiError::bad_request());
        }
        Ok(Self {
            org,
            member,
            revision,
        })
    }
}

fn organization_id(path: &str) -> Option<Uuid> {
    let segment = path.strip_prefix("/api/v1/orgs/")?.split('/').next()?;
    if !segment.contains('%') {
        return segment.parse().ok();
    }
    let mut bytes = segment.bytes();
    let mut decoded = Vec::with_capacity(segment.len());
    while let Some(byte) = bytes.next() {
        decoded.push(if byte == b'%' {
            let high = char::from(bytes.next()?).to_digit(16)?;
            let low = char::from(bytes.next()?).to_digit(16)?;
            (high * 16 + low) as u8
        } else {
            byte
        });
    }
    std::str::from_utf8(&decoded).ok()?.parse().ok()
}

pub(crate) struct TargetId(Uuid);

impl FromRequestParts<AppState> for TargetId {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let params = RawPathParams::from_request_parts(parts, state)
            .await
            .map_err(|_| ApiError::bad_request())?;
        params
            .iter()
            .find(|(key, _)| matches!(*key, "id" | "channel_id"))
            .and_then(|(_, value)| value.parse().ok())
            .map(Self)
            .ok_or_else(ApiError::bad_request)
    }
}

impl Owner {
    async fn current_role(self, tx: &mut PgConnection, lock: bool) -> Result<Role, ApiError> {
        sqlx::query_scalar(&format!(
            "SELECT role FROM ({}) u",
            auth::current_member_sql(lock)
        ))
        .bind(self.org)
        .bind(self.member)
        .bind(self.revision)
        .fetch_optional(tx)
        .await?
        .ok_or_else(ApiError::organization_unavailable)
    }

    async fn generation(self, tx: &mut PgConnection) -> Result<i64, sqlx::Error> {
        Ok(sqlx::query_scalar(
            "SELECT generation FROM member_section_generations WHERE organization_id=$1 AND member_id=$2",
        )
        .bind(self.org)
        .bind(self.member)
        .fetch_optional(tx)
        .await?
        .unwrap_or(0))
    }
}

fn section_not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "section_not_found", None)
}

fn channel_not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "channel not found", None)
}

fn layout_changed() -> ApiError {
    ApiError(StatusCode::CONFLICT, "section_layout_changed", None)
}

fn validate_name(name: &str) -> Result<(), ApiError> {
    if name.is_empty() || name.contains('\0') || name.trim() != name || name.chars().count() > 60 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_section_name",
            None,
        ));
    }
    Ok(())
}

fn validate_order(ids: &[Uuid], limit: usize) -> Result<(), ApiError> {
    if ids.len() > limit || ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_section_order",
            None,
        ));
    }
    Ok(())
}

pub(crate) fn router(activity: activity::Activity) -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/orgs/{org}/me/sections",
            get(read::layout).post(write::create),
        )
        .route(
            "/api/v1/orgs/{org}/me/sections/{id}",
            get(read::section)
                .patch(write::rename)
                .delete(write::delete),
        )
        .route(
            "/api/v1/orgs/{org}/me/sections/order",
            get(read::section)
                .patch(write::rename)
                .delete(write::delete)
                .put(write::section_order),
        )
        .route(
            "/api/v1/orgs/{org}/me/channel-sections/{channel_id}",
            get(read::placement).put(write::move_channel),
        )
        .route(
            "/api/v1/orgs/{org}/me/section-channel-order",
            put(write::channel_order).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .layer(Extension(activity))
}

#[cfg(test)]
mod tests;
