use super::*;
use axum::extract::{Query, State, rejection::QueryRejection};

pub(crate) async fn bump(
    connection: &mut PgConnection,
    org: Uuid,
    channel: Uuid,
    grants: &[(Uuid, i64, Uuid)],
) -> Result<(), sqlx::Error> {
    let mut grants = grants.to_vec();
    grants.sort_by_key(|g| g.0);
    let mut positions = Vec::with_capacity(grants.len());
    for (member, revision, grant) in grants {
        let p:i64=sqlx::query_scalar("INSERT INTO dm_discovery_counters(organization_id,member_id,membership_revision,position) VALUES($1,$2,$3,1) ON CONFLICT(organization_id,member_id,membership_revision) DO UPDATE SET position=dm_discovery_counters.position+1 RETURNING position")
            .bind(org).bind(member).bind(revision).fetch_one(&mut *connection).await?;
        positions.push((member, revision, grant, p));
    }
    for (member, revision, grant, p) in positions {
        sqlx::query("INSERT INTO dm_discovery(organization_id,member_id,membership_revision,channel_id,grant_id,birth_position,latest_position) VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(organization_id,member_id,membership_revision,channel_id) DO UPDATE SET latest_position=EXCLUDED.latest_position,grant_id=EXCLUDED.grant_id")
            .bind(org).bind(member).bind(revision).bind(channel).bind(grant).bind(p).execute(&mut *connection).await?;
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DmChanges {
    pub dms: Vec<DmDiscovery>,
    pub next_cursor: String,
    pub caught_up: bool,
}

#[utoipa::path(get,path="/api/v1/orgs/{org}/dms/changes",operation_id="dm_changes",
    params(("org"=Uuid,Path),("lane"=String,Query,description="Required delta or coverage"),("cursor"=Option<String>,Query,description="Opaque lane-specific continuation")),
    security(("cookie"=[]),("bearer"=[])),
    responses((status=200,description="At most 50 authorized identities, no Unread or Message scans; independent rolling delta or frozen-birth coverage",body=DmChanges),
    (status=400,description="invalid input, including unknown fields or wrong-scope cursor",body=ErrorBody),
    (status=401,description="invalid credentials",body=ErrorBody),(status=404,description="organization_unavailable",body=ErrorBody),
    (status=500,description="internal error",body=ErrorBody)))]
pub async fn changes(
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
            let mut lane = None;
            let mut token = None;
            for (k, v) in query {
                match k.as_str() {
                    "lane" if lane.is_none() && matches!(v.as_str(), "delta" | "coverage") => {
                        lane = Some(v)
                    }
                    "cursor" if token.is_none() => token = Some(v),
                    _ => return Err(ApiError::bad_request()),
                }
            }
            let lane = lane.ok_or_else(ApiError::bad_request)?;
            let cursor = token
                .map(|t| Cursor::decode(&t, &state.setup_token, &auth, &lane))
                .transpose()?
                .unwrap_or_default();
            let response = page(tx, &auth, &state.setup_token, &lane, cursor).await?;
            Ok(([(header::CACHE_CONTROL, "no-store")], Json(response)).into_response())
        },
    )
    .await
}

pub(crate) async fn page(
    tx: &mut PgConnection,
    auth: &Auth,
    secret: &str,
    lane: &str,
    mut cursor: Cursor,
) -> Result<DmChanges, ApiError> {
    let org = auth.identity.organization.organization_id;
    let h:i64=sqlx::query_scalar("SELECT COALESCE((SELECT position FROM dm_discovery_counters WHERE organization_id=$1 AND member_id=$2 AND membership_revision=$3),0)")
        .bind(org).bind(auth.identity.member.id).bind(auth.membership_revision).fetch_one(&mut *tx).await?;
    let coverage = lane == "coverage";
    if coverage && cursor.exhausted {
        cursor = Cursor::default();
    }
    let ceiling = if coverage {
        *cursor.ceiling.get_or_insert(h)
    } else {
        h
    };
    let column = if coverage {
        "birth_position"
    } else {
        "latest_position"
    };
    // LIMIT is applied to the per-recipient index before any identity work.
    let sql = format!(
        "SELECT d.channel_id, CASE WHEN c.lower_member_id=$2 THEN c.higher_member_id ELSE c.lower_member_id END, d.{column} FROM (SELECT * FROM dm_discovery WHERE organization_id=$1 AND member_id=$2 AND membership_revision=$3 AND {column}>$4 AND {column}<=$5 ORDER BY {column} LIMIT 51) d JOIN channel_members cm ON cm.organization_id=d.organization_id AND cm.channel_id=d.channel_id AND cm.member_id=d.member_id AND cm.membership_revision=d.membership_revision AND cm.grant_id=d.grant_id JOIN channels c ON c.organization_id=d.organization_id AND c.id=d.channel_id AND c.kind='dm' AND $2 IN(c.lower_member_id,c.higher_member_id) ORDER BY d.{column}"
    );
    let mut rows: Vec<(Uuid, Uuid, i64)> = sqlx::query_as(&sql)
        .bind(org)
        .bind(auth.identity.member.id)
        .bind(auth.membership_revision)
        .bind(cursor.at)
        .bind(ceiling)
        .fetch_all(&mut *tx)
        .await?;
    let caught_up = rows.len() <= 50;
    rows.truncate(50);
    cursor.at = if caught_up {
        ceiling
    } else {
        rows.last().map(|r| r.2).unwrap_or(cursor.at)
    };
    cursor.exhausted = caught_up;
    let dms = identities(
        tx,
        auth,
        rows.into_iter()
            .map(|r| (r.0, r.1, String::new()))
            .collect(),
    )
    .await?
    .into_iter()
    .map(|d| d.identity)
    .collect();
    Ok(DmChanges {
        dms,
        next_cursor: cursor.encode(secret, auth, lane)?,
        caught_up,
    })
}
