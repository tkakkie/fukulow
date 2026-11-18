use super::*;
use std::time::Duration;

mod atomicity;
pub(crate) mod counts;
mod denials;
mod measurement;
mod paging;
mod sends;

fn reply_input(key: Uuid, parent: &Value) -> Value {
    json!({"client_message_id":key,"body":"Reply payload","reply_to":parent["id"]})
}

fn id(message: &Value) -> Uuid {
    message["id"].as_str().unwrap().parse().unwrap()
}

async fn chain(app: &Router, token: &str, channel: Uuid, anchor: Uuid, query: &str) -> Response {
    request(
        app,
        "GET",
        &format!("/api/v1/channels/{channel}/messages/{anchor}/chain{query}"),
        token,
        Value::Null,
    )
    .await
}

async fn page(app: &Router, token: &str, channel: Uuid, anchor: Uuid, query: &str) -> Value {
    let response = chain(app, token, channel, anchor, query).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let mut page = body(response).await;
    assert!(Uuid::parse_str(page["history_generation"].as_str().unwrap()).is_ok());
    page.as_object_mut().unwrap().remove("history_generation");
    assert!(page["as_of_seq"].is_i64());
    page.as_object_mut().unwrap().remove("as_of_seq");
    page
}

async fn counts(pool: &PgPool, org: Uuid, channel: Uuid) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT count(*) FROM messages WHERE organization_id=$1 AND channel_id=$2), COALESCE((SELECT seq FROM channel_message_sequences WHERE organization_id=$1 AND channel_id=$2),0), COALESCE((SELECT sum(message_count)::bigint FROM topics WHERE organization_id=$1 AND channel_id=$2),0)")
        .bind(org).bind(channel).fetch_one(pool).await.unwrap()
}

async fn error(response: Response, status: StatusCode, expected: &str) {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
    assert_eq!(body(response).await, json!({"error":expected}));
}
