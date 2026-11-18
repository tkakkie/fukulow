use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct Mention {
    pub member_id: Uuid,
    /// Current retained Member name in this authorized Message snapshot.
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
pub struct Message {
    pub history_generation: Uuid,
    pub id: Uuid,
    pub channel_id: Uuid,
    /// Immutable creation position in the Channel log.
    #[schema(minimum = 1)]
    pub created_seq: i64,
    /// Last Channel event position affecting this state.
    #[schema(minimum = 1)]
    pub version: i64,
    pub deleted: bool,
    pub client_message_id: Uuid,
    /// Member id of the sender.
    pub sender: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(nullable = false)]
    pub body: Option<String>,
    #[schema(format = DateTime)]
    pub created_at: String,
    #[schema(required = true)]
    pub topic_id: Option<Uuid>,
    /// Confirmed parent Message; null for a non-Reply.
    #[schema(required = true)]
    pub reply_to: Option<Uuid>,
    /// Stable root even when the parent is outside the loaded window; null for a non-Reply.
    #[schema(required = true)]
    pub reply_root_id: Option<Uuid>,
    /// Persisted accepted ids, sorted by UUID, with current retained display names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(nullable = false)]
    pub mentions: Option<Vec<Mention>>,
}

/// Idempotency key: (organization, sender, client_message_id), derived from the session.
/// Matching body, Channel, normalized Topic name and reply target returns the canonical Message/sequence;
/// changing any of them returns 409.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SendMessageRequest {
    pub history_generation: Option<Uuid>,
    pub client_message_id: Uuid,
    /// 1..=4000 Unicode scalar values; no NUL or whitespace-only body. Stored without trimming.
    #[schema(min_length = 1, max_length = 4000)]
    pub body: String,
    /// Join or create a Topic in this Channel. Omitted/null sends without a Topic unless replying.
    /// 1..=60 Unicode scalars, no NUL or surrounding/only trim whitespace; ASCII case folds.
    #[schema(min_length = 1, max_length = 60)]
    pub topic_name: Option<String>,
    /// Confirmed parent in this Organization/Channel. Omitted/null is a non-Reply.
    /// A Reply inherits its parent's Topic; topic_name must be omitted/null.
    pub reply_to: Option<Uuid>,
}

#[derive(Debug, Serialize, Deserialize, IntoParams, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct HistoryQuery {
    pub history_generation: Option<Uuid>,
}

/// Use after_seq XOR before_seq, or neither for the latest page. Cursors are exclusive.
#[derive(Debug, Serialize, Deserialize, IntoParams, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct ListMessagesQuery {
    pub history_generation: Option<Uuid>,
    #[param(minimum = 0)]
    pub as_of_seq: Option<i64>,
    /// Return created_seq > after_seq; 0 starts at the beginning. Cannot combine with before_seq.
    #[param(minimum = 0)]
    #[schema(minimum = 0)]
    pub after_seq: Option<i64>,
    /// Return created_seq < before_seq. Cannot combine with after_seq.
    #[param(minimum = 1)]
    #[schema(minimum = 1)]
    pub before_seq: Option<i64>,
    /// Page size, default 50, maximum 200.
    #[param(minimum = 1, maximum = 200, default = 50)]
    #[schema(minimum = 1, maximum = 200)]
    pub limit: Option<u16>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct MessagePage {
    pub history_generation: Uuid,
    /// Trusted committed event watermark; usable as the initial bootstrap cursor.
    #[schema(minimum = 0)]
    pub as_of_seq: i64,
    /// Always ascending created_seq (newest last), including latest and before_seq pages.
    pub messages: Vec<Message>,
    /// More messages exist in the queried direction (older for latest/before_seq,
    /// newer for after_seq). Continue after_seq with the last created_seq or before_seq
    /// with the first created_seq; continue the latest page toward older messages with before_seq.
    pub has_more: bool,
}

/// Bounded ascending Channel log page, with the same envelopes as WebSocket replay.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ChannelEventPage {
    pub history_generation: Uuid,
    pub events: Vec<ServerEvent>,
    pub has_more: bool,
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[into_params(parameter_in = Query)]
pub struct ListChannelEventsQuery {
    pub history_generation: Option<Uuid>,
    /// Exclusive event position; 0 starts at the beginning.
    #[param(minimum = 0)]
    pub after_seq: i64,
    /// Page size, default 50, maximum 200.
    #[param(minimum = 1, maximum = 200, default = 50)]
    pub limit: Option<u16>,
}

/// Queue overflow: reconnect and subscribe from the last seq per channel; never drop silently.
pub const CLOSE_QUEUE_OVERFLOW: u16 = 4008;
/// Session expired or signed out: stop protected delivery and go to Sign in.
pub const CLOSE_SESSION_ENDED: u16 = 4001;
/// Membership ended for this Organization only: terminal unavailable, no reconnect.
pub const CLOSE_ORGANIZATION_UNAVAILABLE: u16 = 4003;
/// Control-frame budget exhausted: reconnect with backoff, as after 4008.
pub const CLOSE_RATE_LIMITED: u16 = 4029;

/// Client -> server control messages. Cursors are per channel and exclusive.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Subscribe {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        history_generation: Option<Uuid>,
        channel_id: Uuid,
        /// Replay committed Channel events with seq > after_seq; 0 starts at the beginning.
        #[schema(minimum = 0)]
        after_seq: i64,
    },
    Unsubscribe {
        channel_id: Uuid,
    },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MessageStateKind {
    Create,
    Edit,
    Delete,
}

/// The body-free invalidation for a committed whole-chain Move.
#[derive(Clone, Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct MessageMoveEvent {
    #[serde(rename = "type")]
    pub event_type: MessageEventType,
    pub kind: MoveEventKind,
    pub history_generation: Uuid,
    pub channel_id: Uuid,
    #[schema(minimum = 1)]
    pub seq: i64,
    #[schema(minimum = 1)]
    pub version: i64,
    pub root_id: Uuid,
    #[schema(required = true)]
    pub source_topic_id: Option<Uuid>,
    pub destination_topic_id: Uuid,
    pub operation_id: Uuid,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MessageEventType {
    Message,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum MoveEventKind {
    Move,
}

/// Server -> client events. Event positions and Message state versions are independent.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    /// Own-Member DM list invalidation.
    DmListChanged,
    ActivityReady,
    ActivityReset,
    ChannelActivity {
        channel_id: Uuid,
        #[schema(minimum = 1)]
        seq: i64,
    },
    ReadPositionChanged {
        channel_id: Uuid,
        #[schema(required = true)]
        topic_id: Option<Uuid>,
        #[schema(minimum = 0)]
        read_seq: i64,
    },
    ChannelAccessGained {
        channel_id: Uuid,
    },
    ChannelAccessRevoked {
        channel_id: Uuid,
    },
    ChannelListChanged,
    ChannelMembersChanged {
        channel_id: Uuid,
    },
    MembersChanged,
    /// Live and replayed messages have exactly the same canonical shape.
    Message {
        #[schema(minimum = 1)]
        seq: i64,
        kind: MessageStateKind,
        message: Message,
    },
    /// Sent after committed replay and queued live events have been handed off.
    Subscribed {
        history_generation: Uuid,
        channel_id: Uuid,
        /// Last sequence caught up through; 0 when the channel has no messages.
        #[schema(minimum = 0)]
        caught_up_seq: i64,
    },
    /// Effective Channel access loss; the socket and other Channels stay open.
    ChannelAccessLost {
        channel_id: Uuid,
    },
    Error {
        code: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel_id: Option<Uuid>,
    },
    #[serde(untagged)]
    Move(MessageMoveEvent),
}
