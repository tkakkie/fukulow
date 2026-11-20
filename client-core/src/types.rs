use fukulow_api::{Message, MessagePage, ServerEvent};
use serde::{Deserialize, Serialize};
use std::rc::Rc;
use uuid::Uuid;

pub type Token = i64;
pub const MAIN_MESSAGE_LIMIT: usize = 400;
pub const TOPIC_MESSAGE_LIMIT: usize = 300;
pub const REPLY_MESSAGE_LIMIT: usize = 200;
pub const INACTIVE_CHANNEL_MESSAGE_LIMIT: usize = 50;
pub const INACTIVE_CHANNEL_LIMIT: usize = 5;
pub const TOTAL_MESSAGE_LIMIT: usize = 1500;
pub const SYNC_MESSAGE_LIMIT: usize =
    TOTAL_MESSAGE_LIMIT - MAIN_MESSAGE_LIMIT - TOPIC_MESSAGE_LIMIT - REPLY_MESSAGE_LIMIT;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(untagged)]
pub enum Failure {
    Status(u16),
    Other(String),
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    ReorderGrace,
    FillBackoff,
    ReconnectBackoff,
    SendRetry,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Page {
    Latest,
    Before,
    After,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Loading,
    Ready,
    Unavailable,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PendingState {
    Sending,
    Throttled,
    Unknown,
    Failed,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Organization {
    Available,
    Unavailable,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Session {
    SignedIn,
    SignInRequired,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub client_message_id: Uuid,
    pub body: String,
    pub state: PendingState,
    pub request: Token,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_wait: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(rename = "reply_to", skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<Uuid>,
    #[serde(rename = "topic_name", skip_serializing_if = "Option::is_none")]
    pub topic_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_root_id: Option<Uuid>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Range {
    pub start: i64,
    pub end: i64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Subscription {
    pub id: Token,
    pub after: i64,
    pub confirmed: bool,
    pub watermark: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelView {
    pub state: Availability,
    pub watched: bool,
    pub cursor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_seq: Option<i64>,
    pub mutation_seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub move_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub move_epoch: Option<Token>,
    #[serde(skip)]
    pub(crate) moved_roots: Rc<std::collections::BTreeMap<Uuid, i64>>,
    #[serde(skip)]
    pub(crate) retired_move_through: i64,
    pub messages: Rc<Vec<Rc<Message>>>,
    pub versions: Rc<std::collections::BTreeMap<Uuid, (i64, bool, i64)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_through: Option<i64>,
    pub retired_versions: Rc<Vec<Range>>,
    pub version_epoch: Token,
    pub advancing: Rc<Vec<Range>>,
    pub pending: Rc<Vec<Pending>>,
    pub has_older: bool,
    pub history_error: bool,
    pub fill_attempt: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held_through: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forgotten_through: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_base: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub older: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subscription: Option<Rc<Subscription>>,
}
impl Default for ChannelView {
    fn default() -> Self {
        Self {
            state: Availability::Loading,
            watched: false,
            cursor: None,
            snapshot_seq: None,
            mutation_seq: 0,
            move_seq: None,
            move_epoch: None,
            moved_roots: Rc::default(),
            retired_move_through: 0,
            messages: Rc::default(),
            versions: Rc::default(),
            retired_through: None,
            retired_versions: Rc::default(),
            version_epoch: 0,
            advancing: Rc::default(),
            pending: Rc::default(),
            has_older: false,
            history_error: false,
            fill_attempt: 0,
            held_through: None,
            forgotten_through: None,
            last_used: None,
            retained_count: None,
            stream_base: None,
            latest: None,
            older: None,
            fill: None,
            wait: None,
            subscription: None,
        }
    }
}
impl ChannelView {
    pub(crate) fn same(&self, other: &Self) -> bool {
        self.state == other.state
            && self.watched == other.watched
            && self.cursor == other.cursor
            && self.snapshot_seq == other.snapshot_seq
            && self.mutation_seq == other.mutation_seq
            && self.move_seq == other.move_seq
            && self.move_epoch == other.move_epoch
            && Rc::ptr_eq(&self.messages, &other.messages)
            && Rc::ptr_eq(&self.versions, &other.versions)
            && Rc::ptr_eq(&self.retired_versions, &other.retired_versions)
            && self.retired_through == other.retired_through
            && self.version_epoch == other.version_epoch
            && Rc::ptr_eq(&self.pending, &other.pending)
            && Rc::ptr_eq(&self.advancing, &other.advancing)
            && match (&self.subscription, &other.subscription) {
                (Some(a), Some(b)) => Rc::ptr_eq(a, b),
                (None, None) => true,
                _ => false,
            }
            && self.has_older == other.has_older
            && self.history_error == other.history_error
            && self.fill_attempt == other.fill_attempt
            && self.held_through == other.held_through
            && self.forgotten_through == other.forgotten_through
            && self.last_used == other.last_used
            && self.retained_count == other.retained_count
            && self.stream_base == other.stream_base
            && self.latest == other.latest
            && self.older == other.older
            && self.fill == other.fill
            && self.wait == other.wait
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    History {
        #[serde(rename = "mutationSeq")]
        mutation_seq: i64,
        channel: Uuid,
        page: Page,
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<i64>,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        stale: bool,
    },
    Send {
        channel: Uuid,
        #[serde(rename = "clientMessageId")]
        client_message_id: Uuid,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        stale: bool,
    },
}
impl Request {
    pub fn channel(&self) -> Uuid {
        match self {
            Self::History { channel, .. } | Self::Send { channel, .. } => *channel,
        }
    }
    pub fn stale(&self) -> bool {
        match self {
            Self::History { stale, .. } | Self::Send { stale, .. } => *stale,
        }
    }
    pub(crate) fn invalidate(&mut self) {
        match self {
            Self::History { stale, .. } | Self::Send { stale, .. } => *stale = true,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Timer {
    pub purpose: Purpose,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<Uuid>,
    #[serde(rename = "clientMessageId", skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<Uuid>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Input {
    SessionStart {
        #[serde(rename = "selfId")]
        self_id: Uuid,
    },
    SessionReplaced {
        #[serde(rename = "selfId")]
        self_id: Uuid,
    },
    HistoryGeneration {
        generation: Option<Uuid>,
    },
    Stop,
    OrganizationUnavailable,
    ConnectionReady {
        connection: Token,
    },
    SocketClosed {
        connection: Token,
        code: u16,
    },
    Event {
        connection: Token,
        event: ServerEvent,
        subscription: Option<Token>,
    },
    Watch {
        channel: Uuid,
    },
    Unwatch {
        channel: Uuid,
    },
    ChannelUnavailable {
        channel: Uuid,
    },
    Refresh {
        channel: Uuid,
    },
    LoadOlder {
        channel: Uuid,
    },
    UserSend {
        channel: Uuid,
        #[serde(rename = "clientMessageId")]
        client_message_id: Uuid,
        body: String,
        reply_to: Option<Uuid>,
        topic_name: Option<String>,
        #[serde(rename = "replyRootId")]
        reply_root_id: Option<Uuid>,
    },
    UserRetry {
        channel: Uuid,
        #[serde(rename = "clientMessageId")]
        client_message_id: Uuid,
    },
    UserDiscard {
        channel: Uuid,
        #[serde(rename = "clientMessageId")]
        client_message_id: Uuid,
    },
    EventsResult {
        request: Token,
        page: fukulow_api::ChannelEventPage,
    },
    HistoryResult {
        request: Token,
        page: MessagePage,
    },
    HistoryFailed {
        request: Token,
        status: Failure,
        error: Option<String>,
    },
    SettleHistory {
        channel: Uuid,
        messages: Vec<Message>,
    },
    SendFailed {
        request: Token,
        status: Failure,
        #[serde(rename = "retryAfterMs")]
        retry_after_ms: Option<f64>,
        error: Option<String>,
    },
    Ack {
        request: Token,
        message: Message,
    },
    TimerElapsed {
        id: Token,
    },
}
/// Identity refresh is a controller hint, independent of the wire input.
#[derive(Debug, Deserialize)]
pub struct StepInput {
    #[serde(flatten)]
    pub input: Input,
    #[serde(default, rename = "refreshMentionNames")]
    pub refresh_mention_names: bool,
}
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Effect {
    Connect {
        id: Token,
    },
    Close,
    Subscribe {
        #[serde(skip_serializing_if = "Option::is_none")]
        history_generation: Option<Uuid>,
        id: Token,
        channel: Uuid,
        after_seq: i64,
    },
    Unsubscribe {
        channel: Uuid,
    },
    FetchHistory {
        #[serde(skip_serializing_if = "Option::is_none")]
        history_generation: Option<Uuid>,
        #[serde(skip_serializing_if = "Option::is_none")]
        as_of_seq: Option<i64>,
        id: Token,
        channel: Uuid,
        page: Page,
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<i64>,
    },
    Send {
        #[serde(skip_serializing_if = "Option::is_none")]
        history_generation: Option<Uuid>,
        id: Token,
        channel: Uuid,
        client_message_id: Uuid,
        body: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reply_to: Option<Uuid>,
        #[serde(skip_serializing_if = "Option::is_none")]
        topic_name: Option<String>,
    },
    Wait {
        id: Token,
        purpose: Purpose,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel: Option<Uuid>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt: Option<u64>,
        #[serde(rename = "delayMs", skip_serializing_if = "Option::is_none")]
        delay_ms: Option<u64>,
    },
    CancelTimer {
        id: Token,
    },
    SignIn,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub effects: Vec<Effect>,
    pub changed_channels: Vec<Uuid>,
    pub records: Vec<(Uuid, Vec<Message>)>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub moves: Vec<MoveVersion>,
    pub state_changed: bool,
}
#[derive(Debug, Serialize)]
pub struct MoveVersion {
    pub channel_id: Uuid,
    pub root_id: Uuid,
    pub version: i64,
    pub destination_topic_id: Uuid,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_generation: Option<Uuid>,
    pub history_epoch: u64,
    pub self_id: Uuid,
    pub organization: Organization,
    pub session: Session,
    pub running: bool,
    pub next: Token,
    pub connection: Option<Token>,
    pub connected: bool,
    pub reconnect_attempt: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconnect_wait: Option<Token>,
}
