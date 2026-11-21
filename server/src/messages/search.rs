use super::*;
use axum::Extension;
use channels::ChannelKind;
use fukulow_api::MessageMoveEvent;
use sqlx::{PgConnection, Row};

mod cursor;
pub(super) mod d3r;
pub use d3r::D3rEngine;

const PAGE_SIZE: usize = 20;

#[derive(Clone, Copy, Default)]
pub enum SearchEngine {
    #[default]
    Disabled,
    D3r(D3rEngine),
}

impl SearchEngine {
    pub fn configured(value: Option<&str>) -> Result<Self, &'static str> {
        match value {
            None | Some("disabled") => Ok(Self::Disabled),
            Some("d3r") => Ok(Self::D3r(D3rEngine)),
            _ => Err("FUKULOW_SEARCH_ENGINE must be disabled or d3r"),
        }
    }

    async fn candidates(
        self,
        tx: &mut PgConnection,
        scopes: &[Uuid],
        request: EngineQuery<'_>,
    ) -> Result<CandidatePage, SearchError> {
        match self {
            Self::Disabled => Err(unavailable().into()),
            Self::D3r(engine) => engine.search(tx, scopes, request).await,
        }
    }

    // Keep the durable index current while serving is disabled.
    pub(super) async fn index_send(
        tx: &mut commit::Transaction,
        organization: Uuid,
        message: Uuid,
    ) -> Result<(), sqlx::Error> {
        D3rEngine::index_send(tx, organization, message).await
    }

    pub(super) fn index_move(tx: &mut commit::Transaction, event: &MessageMoveEvent) {
        D3rEngine::index_move(tx, event);
    }
}

struct EngineQuery<'a> {
    organization: Uuid,
    member: Uuid,
    filter: Option<Uuid>,
    raw: &'a str,
    cursor: Option<&'a str>,
    secret: &'a str,
    page_size: usize,
}

pub(super) struct CandidatePage {
    pub(super) candidates: Vec<(Uuid, String)>,
    pub(super) next_cursor: Option<String>,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    channel_id: Option<Uuid>,
    cursor: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct SearchPage {
    #[schema(max_items = 20)]
    hits: Vec<SearchHit>,
    /// Null when there are no more hits.
    #[schema(required = true)]
    next_cursor: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct SearchHit {
    /// An existing Message. Its deleted field is always false.
    message: Message,
    channel_kind: ChannelKind,
}

/// Search readable Messages, newest first by creation time and then Message id.
/// Each page checks current Channel and DM visibility in its own snapshot.
#[utoipa::path(get, path = "/api/v1/orgs/{org}/search",
    params(("org" = Uuid, Path, description = "Organization id"),
        ("q" = String, Query, description = "Query as typed, up to 256 Unicode scalars after trimming. After Unicode NFKC case folding, every whitespace-separated token must match as a literal substring and at least one token must contain two or more scalars."),
        ("channel_id" = Option<Uuid>, Query, description = "Limit to one visible Channel or DM"),
        ("cursor" = Option<String>, Query, description = "Opaque next_cursor from this search")),
    security(("cookie" = []), ("bearer" = [])),
    responses((status = 200, description = "Page of matching Messages from the full history, newest first. A page can have fewer than 20 hits and still have a next cursor.", body = SearchPage),
        (status = 400, description = "search_query_too_short, search_query_too_long, invalid_cursor, or malformed input", body = ErrorBody),
        (status = 401, description = "Missing, invalid, expired, or revoked Account Session credential", body = ErrorBody),
        (status = 404, description = "organization_unavailable or channel not found for an inaccessible or unknown Channel", body = ErrorBody),
        (status = 503, description = "search_unavailable when disabled or search_timeout when the database statement deadline expires", body = ErrorBody),
        (status = 500, description = "Database failure", body = ErrorBody)))]
pub async fn search(
    State(state): State<AppState>,
    Extension(engine): Extension<SearchEngine>,
    auth: Auth,
    query: Result<Query<SearchQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    if matches!(engine, SearchEngine::Disabled) {
        return Err(unavailable());
    }
    let Query(query) = query.map_err(|_| ApiError::bad_request())?;
    let raw = query.q.as_deref().unwrap_or_default().trim();
    if raw.is_empty() {
        return Err(query_too_short());
    }
    if raw.chars().count() > 256 {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "search_query_too_long",
            None,
        ));
    }
    if raw.contains('\0') {
        return Err(ApiError::bad_request());
    }
    let organization = auth.identity.organization.organization_id;
    crate::database::organization_read_only(&state.pool, organization, async |tx| {
        search_page(tx, engine, &auth, &state.setup_token, raw, &query).await
    })
    .await
    .map(|page| ([(header::CACHE_CONTROL, "no-store")], Json(page)).into_response())
    .map_err(ApiError::from)
}

async fn search_page(
    tx: &mut PgConnection,
    engine: SearchEngine,
    auth: &Auth,
    secret: &str,
    raw: &str,
    input: &SearchQuery,
) -> Result<SearchPage, SearchError> {
    sqlx::query("SET LOCAL statement_timeout = '2s'")
        .execute(&mut *tx)
        .await?;
    let organization = auth.identity.organization.organization_id;
    let member = (auth.identity.member.id, auth.membership_revision);
    let filter = input.channel_id.as_ref().map(std::slice::from_ref);
    let scopes = visible_scopes(tx, organization, member, filter).await?;
    let ids: Vec<_> = scopes.iter().map(|(id, _)| *id).collect();
    let page = engine
        .candidates(
            tx,
            &ids,
            EngineQuery {
                organization,
                member: member.0,
                filter: input.channel_id,
                raw,
                cursor: input.cursor.as_deref(),
                secret,
                page_size: PAGE_SIZE,
            },
        )
        .await?;
    let hits = fetch_hits(tx, organization, member, filter, &page).await?;
    Ok(SearchPage {
        hits,
        next_cursor: page.next_cursor,
    })
}

async fn visible_scopes(
    tx: &mut PgConnection,
    organization: Uuid,
    member: (Uuid, i64),
    filter: Option<&[Uuid]>,
) -> Result<Vec<(Uuid, ChannelKind)>, SearchError> {
    let scopes = channels::search_scopes(tx, organization, member, filter)
        .await?
        .ok_or_else(ApiError::organization_unavailable)?;
    if filter.is_some() && scopes.is_empty() {
        return Err(ApiError(StatusCode::NOT_FOUND, "channel not found", None).into());
    }
    Ok(scopes)
}

pub(super) async fn fetch_hits(
    tx: &mut PgConnection,
    organization: Uuid,
    member: (Uuid, i64),
    filter: Option<&[Uuid]>,
    page: &CandidatePage,
) -> Result<Vec<SearchHit>, SearchError> {
    if page.candidates.is_empty() {
        return Ok(Vec::new());
    }
    // Reauthorize body reads in this page's snapshot, independent of the engine.
    let scopes = visible_scopes(tx, organization, member, filter).await?;
    let scope_kinds: std::collections::HashMap<_, _> = scopes.into_iter().collect();
    let visible: Vec<_> = scope_kinds.keys().copied().collect();
    let (ids, times): (Vec<_>, Vec<_>) = page
        .candidates
        .iter()
        .map(|(id, at)| (*id, at.as_str()))
        .unzip();
    let sql = mentions::page_sql(
        "SELECT m.*, candidate.created_at, candidate.ordinal
         FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS candidate(id, created_at, ordinal)
         CROSS JOIN LATERAL (
             SELECT m.id, m.channel_id, m.seq, m.version, m.deleted, m.client_message_id, m.sender,
                 m.body, m.topic_id, m.reply_to_id AS reply_to, m.reply_root_id
             FROM messages m
             WHERE m.organization_id=$1 AND m.id=candidate.id
                 AND m.created_at=candidate.created_at::timestamptz AND NOT m.deleted
                 AND m.channel_id=ANY($4)
             OFFSET 0
         ) m",
        "p.ordinal",
    );
    let rows = sqlx::query(&sql)
        .bind(organization)
        .bind(ids)
        .bind(times)
        .bind(visible)
        .fetch_all(tx)
        .await?;
    rows.iter()
        .map(|row| {
            Ok(SearchHit {
                channel_kind: *scope_kinds
                    .get(&row.try_get::<Uuid, _>("channel_id")?)
                    .ok_or(sqlx::Error::RowNotFound)?,
                message: message_from_row(row)?,
            })
        })
        .collect()
}

fn unavailable() -> ApiError {
    ApiError(StatusCode::SERVICE_UNAVAILABLE, "search_unavailable", None)
}

fn query_too_short() -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, "search_query_too_short", None)
}

pub(super) enum SearchError {
    Api(ApiError),
    Database(sqlx::Error),
}

impl From<ApiError> for SearchError {
    fn from(error: ApiError) -> Self {
        Self::Api(error)
    }
}

impl From<sqlx::Error> for SearchError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<SearchError> for ApiError {
    fn from(error: SearchError) -> Self {
        match error {
            SearchError::Api(error) => error,
            SearchError::Database(error)
                if error
                    .as_database_error()
                    .and_then(|error| error.code())
                    .as_deref()
                    == Some("57014") =>
            {
                Self(StatusCode::SERVICE_UNAVAILABLE, "search_timeout", None)
            }
            SearchError::Database(error) => error.into(),
        }
    }
}
