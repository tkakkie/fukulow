#![cfg(test)]

use std::collections::BTreeSet;

use axum::{body::Body, http::Request};
use fukulow_server::{
    AppState, app,
    messages::Message,
    openapi::ApiDoc,
    realtime::{CLOSE_QUEUE_OVERFLOW, CLOSE_SESSION_ENDED, ClientMessage, ServerEvent},
};
use serde::Serialize;
use serde_json::{Value, json};
use tower::ServiceExt;
use utoipa::OpenApi;
use uuid::Uuid;

#[test]
fn sign_in_retry_after_is_at_least_one_second() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let schema = &document["paths"]["/api/v1/session"]["post"]["responses"]["429"]["headers"]["Retry-After"]
        ["schema"];
    assert_eq!(schema["type"], "integer");
    assert_eq!(schema["minimum"], 1);
}

fn assert_variant_contract<T: Serialize>(root: &str, variants: &[(T, &str)]) {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let schemas = &document["components"]["schemas"];
    let union = &schemas[root];
    assert_eq!(union["discriminator"]["propertyName"], "type");
    let mapping = union["discriminator"]["mapping"].as_object().unwrap();
    assert_eq!(union["oneOf"].as_array().unwrap().len(), variants.len());
    let mut schema_tags = BTreeSet::new();
    for variant in union["oneOf"].as_array().unwrap() {
        let reference = variant["$ref"].as_str().unwrap();
        let schema = document
            .pointer(reference.strip_prefix('#').unwrap())
            .unwrap();
        assert!(
            schema["required"]
                .as_array()
                .unwrap()
                .contains(&json!("type"))
        );
        let tags = schema["properties"]["type"]["enum"].as_array().unwrap();
        assert_eq!(tags.len(), 1);
        let tag = tags[0].as_str().unwrap();
        assert!(schema_tags.insert(tag));
        assert_eq!(mapping[tag], reference);
    }
    let mut serialized_tags = BTreeSet::new();
    for (variant, expected) in variants {
        let serialized = serde_json::to_value(variant).unwrap();
        assert_eq!(serialized["type"], *expected);
        assert!(serialized_tags.insert(*expected));
        let reference = mapping[*expected].as_str().unwrap();
        let schema = document
            .pointer(reference.strip_prefix('#').unwrap())
            .unwrap();
        for field in schema["required"].as_array().unwrap() {
            assert!(
                serialized.get(field.as_str().unwrap()).is_some(),
                "{serialized}"
            );
        }
    }
    assert_eq!(schema_tags, serialized_tags);
    assert_eq!(mapping.len(), serialized_tags.len());
}

#[test]
fn websocket_variants_serialize_with_the_schema_discriminators() {
    let channel_id = Uuid::from_u128(1);
    assert_variant_contract(
        "ClientMessage",
        &[
            (
                ClientMessage::Subscribe {
                    channel_id,
                    after_seq: 0,
                },
                "subscribe",
            ),
            (ClientMessage::Unsubscribe { channel_id }, "unsubscribe"),
        ],
    );
    let message = Message {
        id: Uuid::from_u128(2),
        channel_id,
        seq: 1,
        client_message_id: Uuid::from_u128(3),
        sender: Uuid::from_u128(4),
        body: "hello".into(),
        created_at: "2026-11-09T00:00:00Z".into(),
        topic_id: (),
    };
    assert_eq!(
        serde_json::to_value(&message).unwrap()["topic_id"],
        Value::Null
    );
    assert_variant_contract(
        "ServerEvent",
        &[
            (ServerEvent::Message { message }, "message"),
            (
                ServerEvent::Subscribed {
                    channel_id,
                    caught_up_seq: 1,
                },
                "subscribed",
            ),
            (
                ServerEvent::Error {
                    code: "test_error".into(),
                    channel_id: None,
                },
                "error",
            ),
        ],
    );
    let without_channel = serde_json::to_value(ServerEvent::Error {
        code: "test_error".into(),
        channel_id: None,
    })
    .unwrap();
    assert!(without_channel.get("channel_id").is_none());
    let with_channel = serde_json::to_value(ServerEvent::Error {
        code: "test_error".into(),
        channel_id: Some(channel_id),
    })
    .unwrap();
    assert_eq!(with_channel["channel_id"], json!(channel_id));
    assert_eq!(CLOSE_QUEUE_OVERFLOW, 4008);
    assert_eq!(CLOSE_SESSION_ENDED, 4001);
}

#[tokio::test]
async fn websocket_upgrade_requires_authentication_without_database_access() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let router = app(AppState {
        pool,
        cookie_secure: true,
        setup_token: None,
        sign_in_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        ws_allowed_origins: Default::default(),
    });
    for (method, path) in [("GET", "/api/v1/ws")] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 401, "{method} {path}");
    }
}
