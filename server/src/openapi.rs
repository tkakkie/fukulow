use utoipa::{
    Modify, OpenApi,
    openapi::{
        RefOr,
        schema::{Discriminator, Ref, Schema},
        security::{ApiKey, ApiKeyValue, Http, HttpAuthScheme, SecurityScheme},
    },
};

#[derive(OpenApi)]
#[openapi(
    paths(crate::health, crate::ready, crate::auth::setup_status, crate::auth::setup, crate::auth::sign_in, crate::auth::native_sign_in, crate::auth::sign_out, crate::auth::me, crate::auth::organization_me, crate::auth::members::list_members, crate::auth::members::change_role, crate::auth::members::deactivate, crate::auth::invites::create_invite, crate::auth::invites::accept_invite,
        crate::messages::unread::list_channels, crate::messages::unread::mark_channel_read, crate::messages::unread::mark_topic_read, crate::channels::create_channel, crate::channels::members::list, crate::channels::members::add, crate::channels::members::remove, crate::channels::members::change_manager,
        crate::messages::list_messages, crate::messages::send_message, crate::messages::replies::reply_chain, crate::messages::topics::projection::list_timeline, crate::messages::topics::projection::list_topics, crate::messages::topics::projection::topic_summary, crate::messages::topics::topic_history, crate::realtime::upgrade),
    components(schemas(crate::auth::Capability, crate::auth::OrganizationCapabilities, crate::auth::members::MemberList, crate::auth::members::ChangeRoleRequest, crate::auth::invites::CreateInviteRequest, crate::auth::invites::InviteResponse, crate::auth::invites::AcceptInviteRequest, crate::auth::Account, crate::auth::AccountIdentity, crate::auth::SetupStatus, crate::auth::SetupRequest, crate::auth::SignInRequest, crate::auth::Identity, crate::auth::Organization, crate::auth::Member, crate::auth::Role, crate::auth::SessionResponse, crate::auth::NativeSessionResponse, crate::auth::ErrorBody,
        crate::channels::members::AddChannelMemberRequest, crate::channels::members::ChangeChannelManagerRequest, crate::channels::members::ChannelMember, crate::channels::members::ChannelMemberList, crate::channels::Channel, crate::channels::ChannelCapabilities, crate::channels::ChannelVisibility, crate::channels::CreateChannelRequest, crate::messages::ChannelList, crate::messages::UnreadChannel, crate::messages::MarkReadRequest, crate::messages::ReadPosition,
        crate::messages::Message, crate::messages::SendMessageRequest, crate::messages::ListMessagesQuery, crate::messages::MessagePage, crate::messages::ReplyChainPage, crate::messages::ReplyChainQuery, crate::messages::ListProjectionQuery, crate::messages::TimelineItem, crate::messages::TimelinePage, crate::messages::TopicPage, crate::messages::TopicSummary, crate::messages::TopicSummaryResponse,
        crate::realtime::ClientMessage, crate::realtime::ServerEvent)),
    modifiers(&Security, &WebSocketDiscriminators, &ShutdownResponses)
)]
pub struct ApiDoc;

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
            for operation in [
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
            .filter_map(Option::as_mut)
            .chain(item.additional_operations.values_mut())
            {
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
