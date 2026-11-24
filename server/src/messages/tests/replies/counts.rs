use super::*;
use crate::test_support::Gates;

mod contract;
mod denials;
mod plans;
mod races;

static GATES: Gates<Uuid> = Gates::new();
pub(crate) async fn pause(channel: Uuid) {
    GATES.pause(channel).await;
}

async fn query(app: &Router, token: &str, channel: Uuid, ids: &[Uuid]) -> Response {
    request(
        app,
        "POST",
        &format!("/api/v1/channels/{channel}/reply-counts"),
        token,
        json!({"ids":ids}),
    )
    .await
}

async fn page(app: &Router, token: &str, channel: Uuid, ids: &[Uuid]) -> Value {
    let response = query(app, token, channel, ids).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let mut page = body(response).await;
    assert!(Uuid::parse_str(page["history_generation"].as_str().unwrap()).is_ok());
    page.as_object_mut().unwrap().remove("history_generation");
    page
}

fn entry(message: Uuid, root: Uuid, count: i64) -> Value {
    json!({"message_id":message,"root_id":root,"reply_count":count})
}

async fn grant(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query("INSERT INTO channel_members (organization_id,channel_id,member_id,membership_revision) SELECT organization_id,$2,id,membership_revision FROM users WHERE organization_id=$1 AND id=$3")
        .bind(org).bind(channel).bind(member).execute(pool).await.unwrap();
}

async fn revoke(pool: &PgPool, org: Uuid, channel: Uuid, member: Uuid) {
    sqlx::query(
        "DELETE FROM channel_members WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3",
    )
    .bind(org)
    .bind(channel)
    .bind(member)
    .execute(pool)
    .await
    .unwrap();
}
