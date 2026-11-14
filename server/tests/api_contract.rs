#![cfg(test)]

use std::collections::BTreeSet;

use axum::{
    body::{Body, to_bytes},
    http::{Request, header},
};
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
// All 33 operations document shutdown, including author lookup and Account security actions.
const EXPECTED_RESPONSE_OBJECT_COUNT: usize = 232;

#[test]
fn author_lookup_contract_bounds_input_and_retains_deactivated_identity() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    let generated = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for document in [committed, generated] {
        let schemas = &document["components"]["schemas"];
        assert_eq!(
            schemas["AuthorLookupRequest"]["properties"]["ids"]["maxItems"],
            100
        );
        assert_eq!(schemas["AuthorLookupRequest"]["required"], json!(["ids"]));
        assert_eq!(
            schemas["AuthorLookupRequest"]["additionalProperties"],
            false
        );
        assert_eq!(
            schemas["DisplayIdentity"]["required"],
            json!(["id", "name", "deactivated"])
        );
        assert_eq!(
            schemas["DisplayIdentity"]["properties"]["deactivated"]["type"],
            "boolean"
        );
        let operation = &document["paths"]["/api/v1/orgs/{org}/message-authors"]["post"];
        assert_eq!(
            operation["responses"]["400"]["content"]["application/json"]["schema"],
            json!({"$ref":"#/components/schemas/ErrorBody"})
        );
        assert_eq!(
            operation["responses"]["200"]["content"]["application/json"]["schema"],
            json!({"$ref":"#/components/schemas/AuthorIdentities"})
        );
    }
}

#[test]
fn setup_token_contract_is_required_and_non_nullable() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    let generated = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for document in [committed, generated] {
        let schema = &document["components"]["schemas"]["SetupRequest"];
        assert!(
            schema["required"]
                .as_array()
                .unwrap()
                .contains(&json!("setup_token"))
        );
        assert_eq!(schema["properties"]["setup_token"]["type"], json!("string"));
    }
}

#[test]
fn every_api_operation_documents_shutdown_retry_contract() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    let generated = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for document in [committed, generated] {
        let mut operations = 0;
        for (path, item) in document["paths"].as_object().unwrap() {
            assert!(
                path.starts_with("/api/v1/"),
                "static paths are outside OpenAPI"
            );
            for method in HTTP_METHODS {
                let Some(operation) = item.get(method) else {
                    continue;
                };
                operations += 1;
                let response = &operation["responses"]["503"];
                assert_eq!(
                    response["content"]["application/json"]["schema"],
                    json!({"$ref": "#/components/schemas/ErrorBody"}),
                    "{method} {path}"
                );
                let description = response["description"].as_str().unwrap();
                assert!(description.contains("shutting_down"), "{method} {path}");
                assert!(
                    description.contains("instance is stopping"),
                    "{method} {path}"
                );
                assert!(
                    description.contains("same client_message_id"),
                    "{method} {path}"
                );
                let headers = &response["headers"];
                assert_eq!(
                    headers["Retry-After"]["schema"]["type"], "integer",
                    "{method} {path}"
                );
                assert_eq!(
                    headers["Retry-After"]["schema"]["minimum"], 1,
                    "{method} {path}"
                );
                assert_eq!(
                    headers["Retry-After"]["description"],
                    "Jittered retry delay in seconds (1 through 5)",
                    "{method} {path}"
                );
                assert_eq!(
                    headers["Cache-Control"]["description"], "no-store",
                    "{method} {path}"
                );
                if method == "post" && path.ends_with("/messages") {
                    assert!(description.contains("Send admission queue is full"));
                    assert!(description.contains("persistence has not started"));
                } else if (path.contains("/timeline")
                    || path.contains("/topics")
                    || path.ends_with("/chain"))
                    && !path.ends_with("/read")
                {
                    assert!(description.contains("Projection watermark admission unavailable"));
                }
            }
        }
        assert_eq!(operations, 33);
    }
}

#[tokio::test]
async fn shutdown_rejects_every_api_operation_and_static_requests_with_retry_contract() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
        .unwrap();
    let state = AppState {
        pool,
        shutdown: Default::default(),
        cookie_secure: true,
        setup_token: "setup-token-test-only".into(),
        sign_in_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        ws_allowed_origins: Default::default(),
        socket_gate: Default::default(),
    };
    let shutdown = state.shutdown.clone();
    let router = app(state);
    shutdown.begin();
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let mut requests = Vec::new();
    for (path, item) in document["paths"].as_object().unwrap() {
        let path = path
            .replace("{org}", &Uuid::nil().to_string())
            .replace("{id}", &Uuid::nil().to_string())
            .replace("{topic_id}", &Uuid::nil().to_string())
            .replace("{message_id}", &Uuid::nil().to_string())
            .replace("{member_id}", &Uuid::nil().to_string());
        for method in HTTP_METHODS {
            if item.get(method).is_some() {
                requests.push((method.to_uppercase(), path.clone()));
            }
        }
    }
    assert_eq!(requests.len(), 33);
    requests.extend(
        [
            "/",
            "/assets/missing.js",
            "/channels/general",
            "/api/v1/nope",
        ]
        .map(|path| ("GET".into(), path.into())),
    );
    for (method, path) in requests {
        // Malformed bodies and absent credentials/Origin must not bypass the outer rejection.
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method.as_str())
                    .uri(&path)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 503, "{method} {path}");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "application/json");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response.headers()[header::X_CONTENT_TYPE_OPTIONS],
            "nosniff"
        );
        assert_eq!(
            response.headers()[header::REFERRER_POLICY],
            "strict-origin-when-cross-origin"
        );
        assert!(
            response.headers()[header::CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap()
                .contains("default-src 'none'; script-src 'self'")
        );
        let retry: u64 = response.headers()[header::RETRY_AFTER]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        assert!((1..=5).contains(&retry), "{method} {path}: {retry}");
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"error": "shutting_down"})
        );
    }
}

#[test]
fn added_error_responses_have_error_body_and_meaningful_descriptions() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    let generated = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for document in [committed, generated] {
        for (method, path, status, reason) in [
            ("post", "/api/v1/setup", "500", "creating"),
            ("post", "/api/v1/session", "500", "signing in"),
            ("post", "/api/v1/native/session", "500", "signing in"),
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
fn channel_name_schemas_limit_length_to_1_through_128() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for schema in ["Channel", "CreateChannelRequest"] {
        let name = &document["components"]["schemas"][schema]["properties"]["name"];
        assert_eq!(name["maxLength"], 128);
        assert_eq!(name["minLength"], 1);
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
        (
            "/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/chain",
            "get",
        ),
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
        reply_to: None,
        reply_root_id: None,
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
                ServerEvent::ChannelAccessLost { channel_id },
                "channel_access_lost",
            ),
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
        setup_token: "setup-token-test-only".into(),
        sign_in_throttle: Default::default(),
        message_delivery: Default::default(),
        session_changes: Default::default(),
        session_cleanup: Default::default(),
        shutdown: Default::default(),
        ws_allowed_origins: Default::default(),
        socket_gate: Default::default(),
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
        "channels/{id}/messages/{message_id}/chain",
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
fn sign_in_contracts_separate_web_identity_from_native_bearer() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let schemas = &document["components"]["schemas"];
    assert_eq!(
        schemas["SessionResponse"]["properties"]
            .as_object()
            .unwrap()
            .len(),
        2
    );
    assert!(
        schemas["SessionResponse"]["properties"]
            .get("token")
            .is_none()
    );
    assert!(
        schemas["NativeSessionResponse"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("token"))
    );
    let native = &document["paths"]["/api/v1/native/session"]["post"]["responses"];
    assert_eq!(
        native["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/NativeSessionResponse"
    );
    assert!(native["200"].get("headers").is_none());
    assert_eq!(
        native["429"]["headers"]["Retry-After"]["schema"]["minimum"],
        1
    );
    let cookie = &document["components"]["securitySchemes"]["cookie"];
    assert_eq!(cookie["name"], "__Host-fukulow_session");
    assert!(
        cookie["description"]
            .as_str()
            .unwrap()
            .contains("local HTTP")
    );
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
        8
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

#[test]
fn unread_openapi_exposes_positions_counts_and_scoped_monotonic_updates() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let schemas = &document["components"]["schemas"];
    assert_eq!(schemas["MarkReadRequest"]["additionalProperties"], false);
    assert_eq!(
        schemas["MarkReadRequest"]["properties"]["read_seq"]["minimum"],
        0
    );
    assert_eq!(schemas["ReadPosition"]["required"], json!(["read_seq"]));
    let channel = &schemas["UnreadChannel"]["allOf"][1];
    for field in ["as_of_seq", "read_seq", "main_unread_count", "unread_count"] {
        assert!(
            channel["required"]
                .as_array()
                .unwrap()
                .contains(&json!(field))
        );
        assert_eq!(channel["properties"][field]["type"], "integer");
        assert_eq!(channel["properties"][field]["format"], "int64");
    }
    for field in ["read_seq", "unread_count"] {
        assert!(
            schemas["TopicSummary"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!(field))
        );
    }
    for suffix in ["read", "topics/{topic_id}/read"] {
        let path = format!("/api/v1/orgs/{{org}}/channels/{{id}}/{suffix}");
        let operation = &document["paths"][path]["put"];
        assert_eq!(
            operation["requestBody"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/MarkReadRequest"
        );
        assert_eq!(
            operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/ReadPosition"
        );
        assert_eq!(operation["security"], json!([{"cookie":[]},{"bearer":[]}]));
        assert!(
            operation["responses"]["404"]["description"]
                .as_str()
                .unwrap()
                .contains("organization_unavailable")
        );
    }
    assert_eq!(
        schemas["ChannelList"]["properties"]["channels"]["items"]["$ref"],
        "#/components/schemas/UnreadChannel"
    );
}

#[test]
fn reply_openapi_contract_has_nullable_membership_send_target_and_bounded_chain_projection() {
    let document = serde_json::to_value(ApiDoc::openapi()).unwrap();
    let schemas = &document["components"]["schemas"];
    for field in ["reply_to", "reply_root_id"] {
        assert_eq!(
            schemas["Message"]["properties"][field]["type"],
            json!(["string", "null"])
        );
        assert_eq!(schemas["Message"]["properties"][field]["format"], "uuid");
        assert!(
            schemas["Message"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!(field))
        );
    }
    assert_eq!(
        schemas["SendMessageRequest"]["properties"]["reply_to"]["format"],
        "uuid"
    );
    assert!(
        schemas["SendMessageRequest"]["properties"]
            .get("reply_root_id")
            .is_none()
    );
    let operation =
        &document["paths"]["/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/chain"]["get"];
    assert_eq!(
        operation["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/ReplyChainPage"
    );
    for (name, description) in [
        ("org", "Organization id"),
        ("id", "Channel id"),
        (
            "message_id",
            "Root or descendant Message id in the Reply chain",
        ),
    ] {
        let parameter = operation["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
            .unwrap();
        assert_eq!(parameter["description"], description);
    }
    assert_eq!(
        operation["responses"]["401"]["description"],
        "Missing, invalid, expired, or revoked Account Session credential"
    );
    for (name, minimum, maximum, default) in
        [("after_seq", 0, None, 0), ("limit", 1, Some(200), 50)]
    {
        let parameter = operation["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == name)
            .unwrap();
        assert_eq!(parameter["schema"]["minimum"], minimum);
        assert_eq!(parameter["schema"]["default"], default);
        if let Some(max) = maximum {
            assert_eq!(parameter["schema"]["maximum"], max);
        }
    }
    for status in ["400", "401", "404", "500", "503"] {
        assert_eq!(
            operation["responses"][status]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/ErrorBody"
        );
    }
    for field in ["root_id", "messages", "has_more"] {
        assert!(
            schemas["ReplyChainPage"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!(field))
        );
    }
}

#[test]
fn channel_membership_paths_capabilities_and_channel_only_loss_contract_are_generated() {
    let doc = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for (path, method) in [
        ("/api/v1/orgs/{org}/channels/{id}/members", "get"),
        ("/api/v1/orgs/{org}/channels/{id}/members", "post"),
        (
            "/api/v1/orgs/{org}/channels/{id}/members/{member_id}",
            "delete",
        ),
        (
            "/api/v1/orgs/{org}/channels/{id}/members/{member_id}",
            "patch",
        ),
    ] {
        let operation = &doc["paths"][path][method];
        assert!(operation.is_object());
        for status in ["400", "401", "404", "500"] {
            assert_eq!(
                operation["responses"][status]["content"]["application/json"]["schema"]["$ref"],
                "#/components/schemas/ErrorBody"
            );
        }
    }
    let schemas = &doc["components"]["schemas"];
    let properties = schemas["ChannelAccessLost"]["properties"]
        .as_object()
        .unwrap();
    assert_eq!(
        properties.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["channel_id", "type"]
    );
    assert_eq!(
        schemas["ChannelAccessLost"]["required"],
        json!(["channel_id", "type"])
    );
    assert_eq!(
        schemas["AddChannelMemberRequest"]["properties"]
            .as_object()
            .unwrap()
            .len(),
        1
    );
    for name in [
        "can_add_members",
        "can_remove_members",
        "can_leave",
        "can_manage_managers",
    ] {
        assert!(
            schemas["ChannelCapabilities"]["properties"]
                .get(name)
                .is_some()
        );
        assert!(
            schemas["ChannelCapabilities"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!(name))
        );
    }
    assert_eq!(
        schemas["ChangeChannelManagerRequest"]["properties"]["manager"]["type"],
        "boolean"
    );
    assert_eq!(
        schemas["ChangeChannelManagerRequest"]["required"],
        json!(["manager"])
    );
    assert_eq!(
        schemas["ChannelMember"]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["id", "manager", "name", "role"]
    );
    assert!(
        schemas["ChannelMember"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("manager"))
    );
    assert_eq!(
        doc["paths"]["/api/v1/orgs/{org}/channels/{id}/members"]["get"]["responses"]["200"]["content"]
            ["application/json"]["schema"]["$ref"],
        "#/components/schemas/ChannelMemberList"
    );
    let patch = &doc["paths"]["/api/v1/orgs/{org}/channels/{id}/members/{member_id}"]["patch"];
    assert_eq!(
        patch["requestBody"]["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/ChangeChannelManagerRequest"
    );
    for (status, errors) in [
        (
            "400",
            &["channel_manager_private_only", "channel_manager_guest"][..],
        ),
        ("403", &["forbidden"][..]),
        ("404", &["member_not_found", "channel_grant_not_found"][..]),
        ("409", &["last_channel_manager"][..]),
    ] {
        assert_eq!(
            patch["responses"][status]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/ErrorBody"
        );
        let description = patch["responses"][status]["description"].as_str().unwrap();
        for error in errors {
            assert!(description.contains(error));
        }
    }
    assert_eq!(
        schemas["Member"]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["id", "name", "role"]
    );
}

#[test]
fn member_deactivation_contract_uses_member_id_empty_204_and_ordered_denials() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    let generated = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for doc in [committed, generated] {
        let op = &doc["paths"]["/api/v1/orgs/{org}/members/{id}/deactivate"]["post"];
        assert!(op["requestBody"].is_null());
        assert!(op["responses"]["204"]["content"].is_null());
        let target = op["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == "id")
            .unwrap();
        assert_eq!(target["description"], "Member id, not Account id");
        for (status, errors) in [
            ("401", &["Authentication"][..]),
            (
                "403",
                &[
                    "base authorization",
                    "before target lookup",
                    "self-deactivation",
                    "Admin on Owner",
                    "ahead of last_owner",
                ][..],
            ),
            (
                "404",
                &[
                    "organization_unavailable",
                    "unknown, foreign or already inactive",
                    "member_not_found",
                    "repeat requests",
                ][..],
            ),
            (
                "409",
                &[
                    "last_owner precedes last_channel_manager",
                    "Owner/Admin grant or Channel manager right",
                    "Public/unmanaged Channels excepted",
                    "no Channel details",
                    "Every denial leaves state unchanged",
                ][..],
            ),
        ] {
            let response = &op["responses"][status];
            assert_eq!(
                response["content"]["application/json"]["schema"]["$ref"],
                "#/components/schemas/ErrorBody"
            );
            let description = response["description"].as_str().unwrap();
            for error in errors {
                assert!(description.contains(error), "{status}: {error}");
            }
        }
        assert!(
            doc["components"]["schemas"]["OrganizationCapabilities"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("can_deactivate_members"))
        );
    }
}

#[test]
fn account_security_contract_records_paths_errors_and_account_lock_order() {
    let committed: Value = serde_json::from_str(include_str!("../../openapi.json")).unwrap();
    let generated = serde_json::to_value(ApiDoc::openapi()).unwrap();
    for document in [committed, generated] {
        for (path, method, schema) in [
            ("/api/v1/me/password", "put", "ChangePasswordRequest"),
            (
                "/api/v1/me/sessions/revoke-others",
                "post",
                "RevokeOtherSessionsRequest",
            ),
        ] {
            let operation = &document["paths"][path][method];
            assert_eq!(
                operation["requestBody"]["content"]["application/json"]["schema"]["$ref"],
                format!("#/components/schemas/{schema}")
            );
            assert!(
                operation["description"]
                    .as_str()
                    .unwrap()
                    .contains("Lock Account FOR UPDATE, then recheck current Session")
            );
            let responses = &operation["responses"];
            assert!(responses["204"]["content"].is_null());
            assert!(
                responses["401"]["description"]
                    .as_str()
                    .unwrap()
                    .starts_with("Only missing, invalid, expired or revoked Account Session")
            );
            assert!(
                responses["403"]["description"]
                    .as_str()
                    .unwrap()
                    .contains("current_password_incorrect")
            );
            assert!(responses["429"]["headers"]["Retry-After"].is_object());
            for status in ["400", "401", "403", "413", "415", "429", "500", "503"] {
                assert_eq!(
                    responses[status]["content"]["application/json"]["schema"]["$ref"],
                    "#/components/schemas/ErrorBody"
                );
            }
            assert!(
                document["components"]["schemas"][schema]["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("current_password"))
            );
        }
        assert!(
            document["paths"]["/api/v1/me/password"]["put"]["responses"]["400"]["description"]
                .as_str()
                .unwrap()
                .contains("invalid_new_password")
        );
    }
}
