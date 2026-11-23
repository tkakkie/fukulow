use super::*;

mod measurement;
mod plan_cache;

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
    let mut page = body(response).await;
    assert!(Uuid::parse_str(page["history_generation"].as_str().unwrap()).is_ok());
    page.as_object_mut().unwrap().remove("history_generation");
    if page["messages"].is_array() {
        page.as_object_mut().unwrap().remove("as_of_seq");
    }
    page
}

pub(super) mod atomicity;
mod denials;
mod page_plans;
mod paging;
mod sends;

mod concurrency;
