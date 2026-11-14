use super::*;
use crate::auth;
use channels::dms::{self, Cursor, DmDiscovery, DmKind, DmPeer, OpenDmRequest};
use sqlx::{PgConnection, Row};

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Dm {
    pub id: Uuid,
    pub kind: DmKind,
    pub peer: DmPeer,
    pub capabilities: channels::ChannelCapabilities,
    #[schema(minimum = 0)]
    pub as_of_seq: i64,
    #[schema(minimum = 0)]
    pub read_seq: i64,
    #[schema(minimum = 0)]
    pub main_unread_count: i64,
    #[schema(minimum = 0)]
    pub unread_count: i64,
    #[schema(minimum = 0)]
    pub mention_unread_count: i64,
}
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DmList {
    pub dms: Vec<Dm>,
    #[schema(required = true)]
    pub next_cursor: Option<String>,
}

async fn baselines(
    tx: &mut PgConnection,
    auth: &Auth,
    identities: Vec<DmDiscovery>,
) -> Result<Vec<Dm>, ApiError> {
    let ids = identities.iter().map(|d| d.id).collect::<Vec<_>>();
    let rows = sqlx::query(unread::LIST_COUNTS_SQL)
        .bind(auth.identity.organization.organization_id)
        .bind(auth.identity.member.id)
        .bind(auth.membership_revision)
        .bind(&ids)
        .fetch_all(tx)
        .await?;
    let mut counts = std::collections::HashMap::new();
    for row in rows {
        counts.insert(
            row.try_get::<Uuid, _>("channel_id")?,
            (
                row.try_get::<i64, _>("as_of_seq")?,
                row.try_get::<i64, _>("read_seq")?,
                row.try_get::<i64, _>("unread_count")?,
            ),
        );
    }
    identities
        .into_iter()
        .map(|d| {
            let (as_of_seq, read_seq, unread_count) =
                counts.remove(&d.id).ok_or(sqlx::Error::RowNotFound)?;
            Ok(Dm {
                id: d.id,
                kind: d.kind,
                peer: d.peer,
                capabilities: channels::ChannelCapabilities::for_dm(
                    auth.identity.organization.organization_id,
                    auth.identity.member.role,
                ),
                as_of_seq,
                read_seq,
                main_unread_count: unread_count,
                unread_count,
                mention_unread_count: 0,
            })
        })
        .collect()
}

#[utoipa::path(post,path="/api/v1/orgs/{org}/dms",request_body=OpenDmRequest,params(("org"=Uuid,Path)),security(("cookie"=[]),("bearer"=[])),
    responses((status=201,description="Created immutable pair",body=Dm),(status=200,description="Resolved existing DM; explicit renew replaces only lapsed grants",body=Dm),
    (status=400,description="invalid input or dm_self_not_allowed",body=ErrorBody),(status=401,description="invalid credentials",body=ErrorBody),
    (status=403,description="forbidden: Guest cannot open even existing DMs",body=ErrorBody),(status=404,description="organization_unavailable or member_not_found",body=ErrorBody),
    (status=413,description="request body too large",body=ErrorBody),(status=415,description="expected application/json",body=ErrorBody),
    (status=500,description="internal error; unknown outcome is recovered by authorized list traversal",body=ErrorBody)))]
pub async fn open(
    State(state): State<AppState>,
    auth: Auth,
    ApiJson(input): ApiJson<OpenDmRequest>,
) -> Result<Response, ApiError> {
    // The transaction survives HTTP cancellation, including renewal and baselines.
    let result = tokio::spawn(async move {
        let (dm, created, notice) = crate::database::organization(
            &state.pool,
            auth.identity.organization.organization_id,
            async |tx: &mut PgConnection| {
                let (id, created, notice) = dms::open(
                    tx,
                    &auth,
                    &input,
                    &state.message_delivery.channel_access.activity,
                )
                .await?;
                let selected = dms::select(tx, &auth, None, Some(&[id])).await?;
                let dm = baselines(
                    tx,
                    &auth,
                    selected.into_iter().map(|d| d.identity).collect(),
                )
                .await?
                .pop()
                .ok_or(sqlx::Error::RowNotFound)?;
                Ok::<_, ApiError>((dm, created, notice))
            },
        )
        .await?;
        if let Some(notice) = notice {
            notice.committed(state.pool.clone());
        }
        Ok::<_, ApiError>((dm, created))
    })
    .await
    .map_err(|_| ApiError::from(sqlx::Error::WorkerCrashed))??;
    Ok((
        if result.1 {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        [(header::CACHE_CONTROL, "no-store")],
        Json(result.0),
    )
        .into_response())
}

#[utoipa::path(get,path="/api/v1/orgs/{org}/dms",params(("org"=Uuid,Path),("cursor"=Option<String>,Query,description="Creation-order continuation, exclusive"),("channel_id"=Option<Vec<Uuid>>,Query,description="Repeated distinct ids, 1..50; exclusive with cursor")),security(("cookie"=[]),("bearer"=[])),
    responses((status=200,description="At most 50 current participant DMs in one snapshot; ordinary Channels excluded",body=DmList),
    (status=400,description="invalid input, including cursor scope, unknown fields or duplicate ids",body=ErrorBody),(status=401,description="invalid credentials",body=ErrorBody),
    (status=404,description="organization_unavailable",body=ErrorBody),(status=500,description="internal error",body=ErrorBody)))]
pub async fn list(
    State(state): State<AppState>,
    auth: Auth,
    query: Result<Query<Vec<(String, String)>>, QueryRejection>,
) -> Result<Response, ApiError> {
    crate::database::organization_read_only(
        &state.pool,
        auth.identity.organization.organization_id,
        async |tx: &mut PgConnection| {
            auth::members::require_current(tx, &auth).await?;
            let Query(query) = query.map_err(|_| ApiError::bad_request())?;
            let mut token = None;
            let mut ids = Vec::new();
            for (k, v) in query {
                match k.as_str() {
                    "cursor" if token.is_none() => token = Some(v),
                    "channel_id" => {
                        let id = Uuid::parse_str(&v).map_err(|_| ApiError::bad_request())?;
                        if ids.contains(&id) {
                            return Err(ApiError::bad_request());
                        }
                        ids.push(id);
                    }
                    _ => return Err(ApiError::bad_request()),
                }
            }
            if ids.len() > 50 || (token.is_some() && !ids.is_empty()) {
                return Err(ApiError::bad_request());
            }
            let cursor = token
                .map(|t| Cursor::decode(&t, &state.setup_token, &auth, "list"))
                .transpose()?;
            let boundary = cursor
                .as_ref()
                .and_then(|c| c.created_at.as_deref().zip(c.id));
            let mut selected = dms::select(
                tx,
                &auth,
                boundary,
                (!ids.is_empty()).then_some(ids.as_slice()),
            )
            .await?;
            let more = selected.len() > 50;
            selected.truncate(50);
            let next_cursor = if more {
                selected
                    .last()
                    .map(|d| {
                        Cursor {
                            created_at: Some(d.created_at.clone()),
                            id: Some(d.identity.id),
                            ..Default::default()
                        }
                        .encode(&state.setup_token, &auth, "list")
                    })
                    .transpose()?
            } else {
                None
            };
            let dms = baselines(
                tx,
                &auth,
                selected.into_iter().map(|d| d.identity).collect(),
            )
            .await?;
            Ok((
                [(header::CACHE_CONTROL, "no-store")],
                Json(DmList { dms, next_cursor }),
            )
                .into_response())
        },
    )
    .await
}
