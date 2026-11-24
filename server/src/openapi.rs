use std::collections::BTreeMap;

use utoipa::{
    Modify, OpenApi,
    openapi::{
        RefOr,
        path::{Operation, PathItem},
        schema::{AllOfBuilder, Discriminator, ObjectBuilder, OneOfBuilder, Ref, Schema},
        security::{ApiKey, ApiKeyValue, Http, HttpAuthScheme, SecurityScheme},
    },
};

#[derive(OpenApi)]
#[openapi(
    paths(
        crate::channels::sections::read::layout, crate::channels::sections::read::section, crate::channels::sections::read::placement,
        crate::channels::sections::write::create, crate::channels::sections::write::rename, crate::channels::sections::write::delete,
        crate::channels::sections::write::section_order, crate::channels::sections::write::move_channel, crate::channels::sections::write::channel_order,
        crate::messages::search::search,
        crate::messages::dms::open, crate::messages::dms::list, crate::channels::dms::discovery::changes, crate::health, crate::ready, crate::auth::setup_status, crate::auth::setup, crate::auth::sign_in, crate::auth::native_sign_in, crate::auth::sign_out, crate::auth::security::change_password, crate::auth::security::revoke_others, crate::auth::me, crate::auth::organization_me, crate::auth::members::list_members, crate::auth::members::change_role, crate::auth::members::deactivate, crate::auth::invites::management::list_invites, crate::auth::invites::management::revoke_invite, crate::auth::invites::create_invite, crate::auth::invites::accept_invite,
        crate::messages::unread::list_channels, crate::messages::unread::mark_channel_read, crate::messages::unread::mark_topic_read, crate::channels::create_channel, crate::channels::archive::get_channel, crate::channels::archive::update_channel, crate::channels::members::list, crate::channels::members::add, crate::channels::members::remove, crate::channels::members::change_manager,
        crate::messages::authors::lookup_authors, crate::messages::log::list_channel_events, crate::messages::list_messages, crate::messages::send_message, crate::messages::move_topic::move_chain, crate::messages::replies::reply_chain, crate::messages::replies::counts::reply_counts, crate::messages::topics::projection::list_timeline, crate::messages::topics::projection::list_topics, crate::messages::topics::projection::topic_summary, crate::messages::topics::topic_history, crate::realtime::upgrade),
    components(schemas(
        crate::channels::ChannelKind, crate::messages::search::SearchPage, crate::messages::search::SearchHit,
        crate::channels::sections::Section, crate::channels::sections::SectionLayout, crate::channels::sections::SectionSnapshot,
        crate::channels::sections::ChannelPlacement, crate::channels::sections::CreateSection, crate::channels::sections::RenameSection,
        crate::channels::sections::SectionOrder, crate::channels::sections::ChannelOrder, crate::channels::sections::MoveChannel,
        crate::channels::sections::CreatedSection, crate::channels::dms::OpenDmRequest, crate::channels::dms::DmPeer, crate::channels::dms::DmKind, crate::channels::dms::OrdinaryChannelKind, crate::channels::dms::DmDiscovery, crate::channels::dms::discovery::DmChanges, crate::messages::dms::Dm, crate::messages::dms::DmList, crate::auth::invites::management::InvitePage, crate::auth::invites::management::OutstandingInvite, crate::auth::security::ChangePasswordRequest, crate::auth::security::RevokeOtherSessionsRequest, crate::auth::Capability, crate::auth::OrganizationCapabilities, crate::auth::members::MemberList, crate::auth::members::ChangeRoleRequest, crate::auth::invites::CreateInviteRequest, crate::auth::invites::InviteResponse, crate::auth::invites::AcceptInviteRequest, crate::auth::Account, crate::auth::AccountIdentity, crate::auth::SetupStatus, crate::auth::SetupRequest, crate::auth::SignInRequest, crate::auth::Identity, crate::auth::Organization, crate::auth::Member, crate::auth::Role, crate::auth::SessionResponse, crate::auth::NativeSessionResponse, crate::auth::ErrorBody,
        crate::channels::members::AddChannelMemberRequest, crate::channels::members::ChangeChannelManagerRequest, crate::channels::members::ChannelMember, crate::channels::members::ChannelMemberList, crate::channels::Channel, crate::channels::ChannelCapabilities, crate::channels::ChannelVisibility, crate::channels::CreateChannelRequest, crate::channels::archive::UpdateChannelRequest, crate::messages::ChannelList, crate::messages::UnreadChannel, crate::messages::MarkReadRequest, crate::messages::ReadPosition,
        crate::auth::members::DisplayIdentity, crate::messages::authors::AuthorLookupRequest, crate::messages::authors::AuthorIdentities, crate::messages::Message, crate::messages::SendMessageRequest, crate::messages::ListMessagesQuery, crate::messages::MessagePage, crate::messages::ReplyChainPage, crate::messages::ReplyChainQuery, crate::messages::ReplyCountRequest, crate::messages::ReplyCount, crate::messages::ReplyCountPage, crate::messages::ListProjectionQuery, crate::messages::TimelineItem, crate::messages::TimelinePage, crate::messages::TopicPage, crate::messages::TopicSummary, crate::messages::TopicSummaryResponse,
        crate::realtime::ClientMessage, crate::realtime::ServerEvent)),
    modifiers(&Security, &MoveDestination, &WebSocketDiscriminators, &ShutdownResponses, &SectionResponseHeaders, &DOMAIN_TAGS)
)]
pub struct ApiDoc;

const DOMAINS: [&str; 5] = ["auth", "channels", "messages", "realtime", "system"];

const PATH_DOMAINS: &[(&str, &str)] = &[
    ("/api/v1/health", "system"),
    ("/api/v1/me", "auth"),
    ("/api/v1/me/password", "auth"),
    ("/api/v1/me/sessions/revoke-others", "auth"),
    ("/api/v1/native/session", "auth"),
    // GET lives in messages for unread state; both operations share the Channel collection path.
    ("/api/v1/orgs/{org}/channels", "channels"),
    ("/api/v1/orgs/{org}/channels/{id}", "channels"),
    ("/api/v1/orgs/{org}/channels/{id}/events", "messages"),
    ("/api/v1/orgs/{org}/channels/{id}/members", "channels"),
    (
        "/api/v1/orgs/{org}/channels/{id}/members/{member_id}",
        "channels",
    ),
    ("/api/v1/orgs/{org}/channels/{id}/messages", "messages"),
    (
        "/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/chain",
        "messages",
    ),
    (
        "/api/v1/orgs/{org}/channels/{id}/messages/{message_id}/move",
        "messages",
    ),
    ("/api/v1/orgs/{org}/channels/{id}/read", "messages"),
    ("/api/v1/orgs/{org}/channels/{id}/reply-counts", "messages"),
    ("/api/v1/orgs/{org}/channels/{id}/timeline", "messages"),
    ("/api/v1/orgs/{org}/channels/{id}/topics", "messages"),
    (
        "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}",
        "messages",
    ),
    (
        "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/messages",
        "messages",
    ),
    (
        "/api/v1/orgs/{org}/channels/{id}/topics/{topic_id}/read",
        "messages",
    ),
    ("/api/v1/orgs/{org}/dms", "messages"),
    ("/api/v1/orgs/{org}/dms/changes", "channels"),
    ("/api/v1/orgs/{org}/invites", "auth"),
    ("/api/v1/orgs/{org}/invites/accept", "auth"),
    ("/api/v1/orgs/{org}/invites/{id}", "auth"),
    ("/api/v1/orgs/{org}/me", "auth"),
    (
        "/api/v1/orgs/{org}/me/channel-sections/{channel_id}",
        "channels",
    ),
    ("/api/v1/orgs/{org}/me/section-channel-order", "channels"),
    ("/api/v1/orgs/{org}/me/sections", "channels"),
    ("/api/v1/orgs/{org}/me/sections/order", "channels"),
    ("/api/v1/orgs/{org}/me/sections/{id}", "channels"),
    ("/api/v1/orgs/{org}/members", "auth"),
    ("/api/v1/orgs/{org}/members/{id}/deactivate", "auth"),
    ("/api/v1/orgs/{org}/members/{id}/role", "auth"),
    ("/api/v1/orgs/{org}/message-authors", "messages"),
    ("/api/v1/orgs/{org}/search", "messages"),
    ("/api/v1/orgs/{org}/ws", "realtime"),
    ("/api/v1/ready", "system"),
    ("/api/v1/session", "auth"),
    ("/api/v1/setup", "auth"),
];

struct DomainTags<'a>(&'a [(&'a str, &'a str)]);

const DOMAIN_TAGS: DomainTags<'static> = DomainTags(PATH_DOMAINS);

impl Modify for DomainTags<'_> {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let mut domains = BTreeMap::new();
        for &(path, domain) in self.0 {
            assert!(
                DOMAINS.contains(&domain),
                "Invalid OpenAPI domain {domain} for {path}"
            );
            let previous = domains.insert(path, domain);
            assert!(previous.is_none(), "Duplicate OpenAPI domain for {path}");
        }
        for (path, item) in &mut openapi.paths.paths {
            let domain = domains.get(path.as_str()).copied();
            assert!(domain.is_some(), "Missing OpenAPI domain for {path}");
            for operation in operations_mut(item) {
                operation.tags = domain.map(|tag| vec![tag.into()]);
            }
        }
    }
}

fn operations_mut(item: &mut PathItem) -> impl Iterator<Item = &mut Operation> {
    [
        &mut item.get,
        &mut item.put,
        &mut item.post,
        &mut item.delete,
        &mut item.options,
        &mut item.head,
        &mut item.patch,
        &mut item.trace,
        &mut item.query,
    ]
    .into_iter()
    .flatten()
    .chain(item.additional_operations.values_mut())
}

struct SectionResponseHeaders;
impl Modify for SectionResponseHeaders {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::openapi::Header;

        for (path, item) in &mut openapi.paths.paths {
            if ![
                "/me/sections",
                "/me/channel-sections/",
                "/me/section-channel-order",
            ]
            .iter()
            .any(|suffix| path.starts_with(&format!("/api/v1/orgs/{{org}}{suffix}")))
            {
                continue;
            }
            for operation in [
                &mut item.get,
                &mut item.post,
                &mut item.patch,
                &mut item.delete,
                &mut item.put,
            ]
            .into_iter()
            .flatten()
            {
                for response in operation.responses.responses.values_mut() {
                    if let RefOr::T(response) = response {
                        response.headers.insert(
                            "Cache-Control".into(),
                            Header::builder()
                                .description(Some("no-store"))
                                .build()
                                .into(),
                        );
                    }
                }
            }
        }
    }
}

struct ShutdownResponses;
impl Modify for ShutdownResponses {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        use utoipa::{
            PartialSchema,
            openapi::{Content, Header, Response},
        };

        // The outer middleware affects every API operation, before extraction or admission.
        let shutdown = Response::builder()
            .description("This instance is stopping: graceful shutdown rejects new requests with error shutting_down; retry after Retry-After, keeping the same client_message_id for sends")
            .content("application/json", Content::new(Some(Ref::from_schema_name("ErrorBody"))))
            .header("Retry-After", Header::builder()
                .schema(Some(crate::auth::RetryAfterSeconds::schema()))
                .description(Some("Jittered retry delay in seconds (1 through 5)"))
                .build())
            .header("Cache-Control", Header::builder()
                .description(Some("no-store"))
                .build())
            .build();
        for item in openapi.paths.paths.values_mut() {
            for operation in operations_mut(item) {
                let mut response = shutdown.clone();
                if let Some(RefOr::T(admission)) = operation.responses.responses.get("503") {
                    response.description = format!(
                        "{}; alternatively, {}",
                        admission.description, response.description
                    );
                }
                operation
                    .responses
                    .responses
                    .insert("503".into(), response.into());
            }
        }
    }
}

struct Security;
impl Modify for Security {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "bearer",
            SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
        );
        components.add_security_scheme(
            "cookie",
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::with_description("__Host-fukulow_session", "HTTPS production cookie; local HTTP with FUKULOW_COOKIE_SECURE=false uses fukulow_session"))),
        );
    }
}

struct MoveDestination;
impl Modify for MoveDestination {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let Some(schema) = openapi
            .components
            .as_mut()
            .and_then(|components| components.schemas.get_mut("MoveChainRequest"))
        else {
            return;
        };
        let destination = OneOfBuilder::new()
            .item(ObjectBuilder::new().required("topic_id").property(
                "topic_id",
                ObjectBuilder::new().schema_type(utoipa::openapi::schema::Type::String),
            ))
            .item(ObjectBuilder::new().required("topic_name").property(
                "topic_name",
                ObjectBuilder::new().schema_type(utoipa::openapi::schema::Type::String),
            ))
            .build();
        // A null selector is equivalent to omission in the JSON request.
        *schema = Schema::AllOf(
            AllOfBuilder::new()
                .item(schema.clone())
                .item(Schema::OneOf(destination))
                .build(),
        )
        .into();
    }
}

struct WebSocketDiscriminators;
impl Modify for WebSocketDiscriminators {
    #[expect(
        clippy::panic,
        reason = "utoipa Modify cannot return Result; an invalid generated contract must fail API export"
    )]
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        for (root, property, variants) in [
            (
                "ClientMessage",
                "type",
                &[("subscribe", "Subscribe"), ("unsubscribe", "Unsubscribe")][..],
            ),
            (
                "ServerEvent",
                "type",
                &[
                    ("dm_list_changed", "DmListChanged"),
                    ("sections_changed", "SectionsChanged"),
                    ("activity_ready", "ActivityReady"),
                    ("activity_reset", "ActivityReset"),
                    ("channel_activity", "ChannelActivity"),
                    ("read_position_changed", "ReadPositionChanged"),
                    ("channel_access_gained", "ChannelAccessGained"),
                    ("channel_access_revoked", "ChannelAccessRevoked"),
                    ("channel_list_changed", "ChannelListChanged"),
                    ("channel_members_changed", "ChannelMembersChanged"),
                    ("members_changed", "MembersChanged"),
                    ("message", "MessageEvent"),
                    ("subscribed", "Subscribed"),
                    ("channel_access_lost", "ChannelAccessLost"),
                    ("error", "ErrorEvent"),
                ][..],
            ),
            (
                "TimelineItem",
                "kind",
                &[("message", "TimelineMessage"), ("topic", "TimelineTopic")][..],
            ),
        ] {
            // utoipa derives the serde-tagged oneOf items but not a discriminator.
            // Lift those items into components so discriminator mappings target refs;
            // the variant properties still come exclusively from the Rust enum.
            let Some(RefOr::T(Schema::OneOf(mut schema))) = components.schemas.remove(root) else {
                panic!("{root} must be a oneOf");
            };
            if root == "ServerEvent" {
                if schema.items.pop().is_none() {
                    panic!("ServerEvent must contain the Move envelope");
                }
                let Some(message) = schema
                    .items
                    .iter_mut()
                    .zip(variants)
                    .find_map(|(item, (tag, _))| (*tag == "message").then_some(item))
                else {
                    panic!("ServerEvent must contain the Message envelope");
                };
                components
                    .schemas
                    .insert("MessageStateEvent".into(), message.clone());
                // Utoipa tags the untagged serde fallback with its Rust variant
                // name. Reference the actual body-free envelope directly.
                *message = Schema::AllOf(
                    AllOfBuilder::new()
                        .item(Schema::OneOf(
                            OneOfBuilder::new()
                                .item(Ref::from_schema_name("MessageStateEvent"))
                                .item(Ref::from_schema_name("MessageMoveEvent"))
                                .build(),
                        ))
                        .build(),
                )
                .into();
            }
            assert_eq!(schema.items.len(), variants.len());
            let mut discriminator = Discriminator::new(property);
            for (item, (tag, name)) in schema.items.iter_mut().zip(variants) {
                let reference = Ref::from_schema_name(*name);
                discriminator
                    .mapping
                    .insert((*tag).into(), reference.ref_location.clone());
                components
                    .schemas
                    .insert((*name).into(), std::mem::replace(item, reference.into()));
            }
            schema.discriminator = Some(discriminator);
            components
                .schemas
                .insert(root.into(), Schema::OneOf(schema).into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[should_panic(expected = "Invalid OpenAPI domain crate::health for /api/v1/health")]
    fn invalid_openapi_domain_is_rejected() {
        DomainTags(&[("/api/v1/health", "crate::health")]).modify(&mut ApiDoc::openapi());
    }

    #[test]
    #[should_panic(expected = "Missing OpenAPI domain for /api/v1/health")]
    fn missing_openapi_domain_is_rejected() {
        DomainTags(&PATH_DOMAINS[1..]).modify(&mut ApiDoc::openapi());
    }

    #[test]
    #[should_panic(expected = "Duplicate OpenAPI domain for /api/v1/health")]
    fn duplicate_openapi_domain_is_rejected() {
        DomainTags(&[("/api/v1/health", "system"), ("/api/v1/health", "auth")])
            .modify(&mut ApiDoc::openapi());
    }
}
