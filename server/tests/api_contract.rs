#![cfg(test)]

use std::collections::BTreeSet;

use axum::{body::Body, http::Request};
use fukulow_server::{
    AppState, app,
    messages::Message,
    openapi::ApiDoc,
    realtime::{
        CLOSE_ORGANIZATION_UNAVAILABLE, CLOSE_QUEUE_OVERFLOW, CLOSE_SESSION_ENDED, ClientMessage,
        ServerEvent,
    },
};
use serde::Serialize;
use serde_json::{Value, json};
use tower::ServiceExt;
use utoipa::OpenApi;
use uuid::Uuid;

const HTTP_METHODS: [&str; 8] = [
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
];
// Topic projections add four routes with six described responses each.
const EXPECTED_RESPONSE_OBJECT_COUNT: usize = 85;

#[test]
fn added_error_responses_have_error_body_and_meaningful_descriptions() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    let generated = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for document in [committed, generated] {
        for (method, path, status, reason) in [
            ("post", "/api/v1/setup", "500", "creating"),
            ("post", "/api/v1/session", "500", "signing in"),
            ("delete", "/api/v1/session", "500", "revoking"),
            ("get", "/api/v1/me", "500", "session identity"),
            (
                "get",
                "/api/v1/orgs/{org}/channels",
                "500",
                "listing visible Channels",
            ),
            (
                "post",
                "/api/v1/orgs/{org}/channels",
                "500",
                "creating the Channel",
            ),
            (
                "get",
                "/api/v1/orgs/{org}/channels/{id}/messages",
                "500",
                "listing Messages",
            ),
            (
                "post",
                "/api/v1/orgs/{org}/channels/{id}/messages",
                "500",
                "persisting the Message",
            ),
            (
                "post",
                "/api/v1/orgs/{org}/channels/{id}/messages",
                "503",
                "admission",
            ),
            (
                "get",
                "/api/v1/orgs/{org}/ws",
                "500",
                "before WebSocket upgrade",
            ),
            (
                "get",
                "/api/v1/orgs/{org}/ws",
                "400",
                "invalid WebSocket upgrade",
            ),
        ] {
            let response = &document["paths"][path][method]["responses"][status];
            assert_eq!(
                response["content"]["application/json"]["schema"],
                json!({"$ref": "#/components/schemas/ErrorBody"}),
                "{method} {path} {status}"
            );
            let description = response["description"].as_str().unwrap();
            assert!(
                description.contains(reason),
                "{method} {path} {status}: {description}"
            );
        }
    }
}

#[test]
fn generated_openapi_matches_committed_contract() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    let generated = serde_json::to_value(ApiDoc::openapi()).unwrap();

    // Compare JSON values so formatting and object-key order do not hide contract drift.
    assert_eq!(generated, committed);
}

fn check_response_descriptions(responses: &Value, location: &str) -> Result<(), String> {
    for (status, response) in responses.as_object().unwrap() {
        // A Reference Object is not a Response Object; its target is checked separately.
        if status.starts_with("x-") || response.get("$ref").is_some() {
            continue;
        }
        // Non-blank descriptions are a fukulow quality rule, not an OpenAPI 3.1 rule.
        if response
            .get("description")
            .and_then(Value::as_str)
            .is_none_or(|description| description.trim().is_empty())
        {
            return Err(format!(
                "{location}/{status}: missing non-blank description"
            ));
        }
    }
    Ok(())
}

fn check_callback_descriptions(callback: &Value, location: &str) -> Result<(), String> {
    for (expression, path_item) in callback.as_object().unwrap() {
        if expression != "$ref" && !expression.starts_with("x-") {
            check_path_item_descriptions(path_item, &format!("{location}/{expression}"))?;
        }
    }
    Ok(())
}

fn check_path_item_descriptions(path_item: &Value, location: &str) -> Result<(), String> {
    for method in HTTP_METHODS {
        if let Some(operation) = path_item.get(method) {
            let location = format!("{location}/{method}");
            if let Some(responses) = operation.get("responses") {
                check_response_descriptions(responses, &format!("{location}/responses"))?;
            }
            if let Some(callbacks) = operation.get("callbacks").and_then(Value::as_object) {
                for (name, callback) in callbacks {
                    if !name.starts_with("x-") {
                        check_callback_descriptions(
                            callback,
                            &format!("{location}/callbacks/{name}"),
                        )?;
                    }
                }
            }
        }
    }
    Ok(())
}

fn check_document_response_descriptions(document: &Value) -> Result<(), String> {
    for location in ["/paths", "/webhooks", "/components/pathItems"] {
        if let Some(items) = document.pointer(location).and_then(Value::as_object) {
            for (name, path_item) in items {
                if !name.starts_with("x-") {
                    check_path_item_descriptions(path_item, &format!("{location}/{name}"))?;
                }
            }
        }
    }
    if let Some(responses) = document.pointer("/components/responses") {
        check_response_descriptions(responses, "/components/responses")?;
    }
    if let Some(callbacks) = document
        .pointer("/components/callbacks")
        .and_then(Value::as_object)
    {
        for (name, callback) in callbacks {
            if !name.starts_with("x-") {
                check_callback_descriptions(callback, &format!("/components/callbacks/{name}"))?;
            }
        }
    }
    Ok(())
}

#[test]
fn openapi_response_objects_require_descriptions() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    let generated = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for document in [committed, generated] {
        check_document_response_descriptions(&document).unwrap();
    }
}

#[test]
fn response_description_check_rejects_removed_descriptions() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    assert_removed_descriptions_are_rejected(&committed);
}

fn assert_removed_descriptions_are_rejected(committed: &Value) {
    let mut response_count = 0;
    for (path, item) in committed["paths"].as_object().unwrap() {
        for method in HTTP_METHODS {
            let Some(operation) = item.get(method) else {
                continue;
            };
            for (status, response) in operation["responses"].as_object().unwrap() {
                if status.starts_with("x-") || response.get("$ref").is_some() {
                    continue;
                }
                response_count += 1;
                let mut missing = committed.clone();
                missing["paths"][path][method]["responses"][status]
                    .as_object_mut()
                    .unwrap()
                    .remove("description")
                    .unwrap();
                assert_eq!(
                    check_document_response_descriptions(&missing),
                    Err(format!(
                        "/paths/{path}/{method}/responses/{status}: missing non-blank description"
                    ))
                );
            }
        }
    }
    assert_eq!(
        response_count, EXPECTED_RESPONSE_OBJECT_COUNT,
        "Response Object count changed; update the expected count explicitly"
    );
}

#[test]
#[should_panic(expected = "Response Object count changed")]
fn response_description_count_rejects_changed_contract() {
    let mut committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    committed["paths"]["/api/v1/orgs/{org}/channels/{id}/messages"]["post"]["responses"]
        .as_object_mut()
        .unwrap()
        .remove("400")
        .unwrap();
    assert_removed_descriptions_are_rejected(&committed);
}

#[test]
fn response_description_check_ignores_path_item_metadata() {
    let mut path_item = json!({
        "parameters": [{"name": "id", "in": "path", "required": true, "schema": {"type": "string"}}],
        "summary": "Example Path Item",
        "description": "Path Item description",
        "servers": [{"url": "https://example.com"}],
        "$ref": "#/components/pathItems/Example",
        "x-note": {"responses": {"200": {}}}
    });
    for method in HTTP_METHODS {
        path_item[method] = json!({"responses": {"200": {"description": " Success "}}});
    }
    let document = json!({"paths": {"/example": path_item}});
    check_document_response_descriptions(&document).unwrap();
    for method in HTTP_METHODS {
        let mut missing = document.clone();
        missing["paths"]["/example"][method]["responses"]["200"] = json!({});
        assert_eq!(
            check_document_response_descriptions(&missing),
            Err(format!(
                "/paths//example/{method}/responses/200: missing non-blank description"
            ))
        );
    }

    let mut committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    committed["paths"]["/example"] = json!({"parameters": [], "summary": "No operations"});
    assert_removed_descriptions_are_rejected(&committed);
}

#[test]
fn response_description_check_covers_reusable_and_nested_responses() {
    let mut document = json!({
        "paths": {},
        "webhooks": {},
        "components": {
            "responses": {},
            "pathItems": {},
            "callbacks": {},
            "schemas": {"Example": {"properties": {"responses": {"type": "string"}}}}
        }
    });
    let path_item = json!({"post": {"responses": {
        "default": {"description": "Success"},
        "2XX": {"$ref": "#/components/responses/Success"},
        "x-note": "Not a Response Object"
    }}});
    for (location, value, response_location) in [
        (
            "/components/responses",
            json!({"Success": {"description": "Success"}}),
            "/components/responses/Success",
        ),
        (
            "/components/pathItems",
            json!({"Reusable": path_item}),
            "/components/pathItems/Reusable/post/responses/default",
        ),
        (
            "/webhooks",
            json!({"message": path_item}),
            "/webhooks/message/post/responses/default",
        ),
        (
            "/paths",
            json!({"/callback": {"get": {"callbacks": {"message": {"{$request.body#/url}": path_item}}}}}),
            "/paths/~1callback/get/callbacks/message/{$request.body#~1url}/post/responses/default",
        ),
        (
            "/components/callbacks",
            json!({"Message": {"{$request.body#/url}": path_item}}),
            "/components/callbacks/Message/{$request.body#~1url}/post/responses/default",
        ),
    ] {
        *document.pointer_mut(location).unwrap() = value;
        check_document_response_descriptions(&document).unwrap();
        let whitespace = ["", "   ", "\t\r\n", "\u{00a0}\u{3000}"];
        for blank in whitespace {
            assert!(blank.trim().is_empty(), "fixture must be Rust whitespace");
        }
        for invalid in [None, Some(Value::Null), Some(json!(42))]
            .into_iter()
            .chain(whitespace.map(|blank| Some(json!(blank))))
        {
            let mut missing = document.clone();
            let response = missing
                .pointer_mut(response_location)
                .unwrap()
                .as_object_mut()
                .unwrap();
            if let Some(value) = invalid {
                response.insert("description".into(), value);
            } else {
                response.remove("description");
            }
            assert!(
                check_document_response_descriptions(&missing).is_err(),
                "{response_location}"
            );
        }
    }
}

#[test]
fn channel_name_schemas_limit_length_to_128() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for schema in ["Channel", "CreateChannelRequest"] {
        let name = &document["components"]["schemas"][schema]["properties"]["name"];
        assert_eq!(name["maxLength"], 128);
        assert!(name.get("minLength").is_none());
    }
}

#[test]
fn sign_in_retry_after_is_at_least_one_second() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let schema = &document["paths"]["/api/v1/session"]["post"]["responses"]["429"]["headers"]["Retry-After"]
        ["schema"];
    assert_eq!(schema["type"], "integer");
    assert_eq!(schema["minimum"], 1);
}

#[test]
fn send_and_topic_admission_retry_after_is_at_least_one_second() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for (path, method) in [
        ("/api/v1/orgs/{org}/channels/{id}/messages", "post"),
        ("/api/v1/orgs/{org}/channels/{id}/timeline", "get"),
        ("/api/v1/orgs/{org}/channels/{id}/topics", "get"),
        ("/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}", "get"),
        (
            "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/messages",
            "get",
        ),
    ] {
        let schema = &document["paths"][path][method]["responses"]["503"]["headers"]["Retry-After"]
            ["schema"];
        assert_eq!(schema["type"], "integer", "{method} {path}");
        assert_eq!(schema["minimum"], 1, "{method} {path}");
    }
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
        topic_id: None,
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
    assert_eq!(CLOSE_ORGANIZATION_UNAVAILABLE, 4003);
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
        shutdown: Default::default(),
        ws_allowed_origins: Default::default(),
    });
    for (method, path) in [(
        "GET",
        "/api/v1/orgs/00000000-0000-0000-0000-000000000000/ws",
    )] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", "chat.example")
                    .header("origin", "https://chat.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 401, "{method} {path}");
    }
}

#[test]
fn account_and_member_openapi_contracts_are_separate() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    assert!(
        document["components"]["schemas"]["SignInRequest"]["properties"]
            .get("organization_id")
            .is_none()
    );
    assert!(
        document["components"]["schemas"]["Member"]["properties"]
            .get("email")
            .is_none()
    );
    for suffix in [
        "me",
        "channels",
        "channels/{id}/messages",
        "channels/{id}/timeline",
        "channels/{id}/topics",
        "channels/{id}/topics/{topic_id}",
        "channels/{id}/topics/{topic_id}/messages",
        "ws",
    ] {
        let path = format!("/api/v1/orgs/{{org}}/{suffix}");
        let item = &document["paths"][&path];
        for method in ["get", "post"] {
            if let Some(operation) = item.get(method) {
                let response = &operation["responses"]["404"];
                assert!(
                    operation["responses"]["400"]["description"]
                        .as_str()
                        .unwrap()
                        .contains("Organization id")
                );
                assert!(
                    response["description"]
                        .as_str()
                        .unwrap()
                        .contains("organization_unavailable"),
                    "{method} {path}"
                );
            }
        }
    }
    assert!(document["paths"].get("/api/v1/ws").is_none());
    assert!(document["paths"].get("/api/v1/channels").is_none());
}

#[test]
fn topic_openapi_contract_includes_all_shapes_and_discriminators() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let schemas = &document["components"]["schemas"];
    assert_eq!(
        schemas["Message"]["properties"]["topic_id"]["type"],
        json!(["string", "null"])
    );
    assert_eq!(
        schemas["Message"]["properties"]["topic_id"]["format"],
        "uuid"
    );
    assert!(
        schemas["Message"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("topic_id"))
    );
    assert!(
        schemas["SendMessageRequest"]["properties"]
            .get("topic_id")
            .is_none()
    );
    assert_eq!(schemas["SendMessageRequest"]["additionalProperties"], false);
    let item = &schemas["TimelineItem"];
    assert_eq!(item["discriminator"]["propertyName"], "kind");
    assert_eq!(
        item["discriminator"]["mapping"],
        json!({"message":"#/components/schemas/TimelineMessage","topic":"#/components/schemas/TimelineTopic"})
    );
    assert_eq!(
        schemas["TimelineMessage"]["properties"]["kind"]["enum"],
        json!(["message"])
    );
    assert_eq!(
        schemas["TimelineTopic"]["properties"]["kind"]["enum"],
        json!(["topic"])
    );
    assert_eq!(
        schemas["TopicSummary"]["required"]
            .as_array()
            .unwrap()
            .len(),
        6
    );
    for (route, shape) in [
        ("timeline", "TimelinePage"),
        ("topics", "TopicPage"),
        ("topics/{topic_id}", "TopicSummaryResponse"),
        ("topics/{topic_id}/messages", "MessagePage"),
    ] {
        let path = format!("/api/v1/orgs/{{org}}/channels/{{id}}/{route}");
        assert_eq!(
            document["paths"][path]["get"]["responses"]["200"]["content"]["application/json"]["schema"]
                ["$ref"],
            format!("#/components/schemas/{shape}")
        );
    }
}
