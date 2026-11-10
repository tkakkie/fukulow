use super::*;

mod measurement;

pub(super) fn topic_input(key: Uuid, name: &str) -> Value {
    json!({"client_message_id": key, "body": "Topic Message", "topic_name": name})
}

async fn get(app: &Router, token: &str, channel: Uuid, suffix: &str) -> Value {
    let response = request(
        app,
        "GET",
        &format!("/api/v1/channels/{channel}/{suffix}"),
        token,
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    body(response).await
}

pub(super) mod atomicity;
mod denials;
mod paging;
mod sends;

mod concurrency;
