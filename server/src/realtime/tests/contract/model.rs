use super::*;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct File {
    pub kind: String,
    /// Raw, so a proposed scenario (planned vocabulary, not implemented yet) is skipped before typed parsing.
    pub scenarios: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Scenario {
    pub id: String,
    #[serde(rename = "title")]
    _title: String,
    #[serde(rename = "covers")]
    _covers: Vec<String>,
    pub rust: RustCoverage,
    pub setup: Setup,
    pub steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RustCoverage {
    pub existing_tests: Vec<String>,
    #[serde(rename = "note")]
    _note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Setup {
    pub organizations: Vec<String>,
    pub members: Vec<MemberSpec>,
    pub channels: Vec<ChannelSpec>,
    #[serde(default)]
    pub unknown_channels: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MemberSpec {
    pub id: String,
    pub organization: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ChannelSpec {
    pub id: String,
    pub organization: String,
    pub creator: String,
    pub visibility: String,
    pub members: Option<Vec<String>>,
    #[serde(default)]
    pub messages: usize,
    pub count: Option<usize>,
}
impl ChannelSpec {
    pub fn labels(&self) -> Vec<String> {
        self.count.map_or_else(
            || vec![self.id.clone()],
            |count| (1..=count).map(|i| format!("{}#{i}", self.id)).collect(),
        )
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum ChannelRef {
    Label(String),
    Range {
        group: String,
        from: usize,
        to: usize,
    },
}
impl ChannelRef {
    pub fn labels(&self) -> Vec<String> {
        match self {
            Self::Label(label) => vec![label.clone()],
            Self::Range { group, from, to } => {
                (*from..=*to).map(|i| format!("{group}#{i}")).collect()
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(super) enum Seq {
    Number(i64),
    Range { from: i64, to: i64 },
}
impl Seq {
    pub fn values(&self) -> std::ops::RangeInclusive<i64> {
        match *self {
            Self::Number(seq) => seq..=seq,
            Self::Range { from, to } => from..=to,
        }
    }
}

fn one() -> usize {
    1
}
fn created() -> u16 {
    201
}

#[derive(Debug, Deserialize)]
#[serde(tag = "do", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Step {
    Connect {
        socket: String,
        #[serde(rename = "as")]
        member: String,
        expect_handshake: Option<u16>,
    },
    CloseSocket {
        socket: String,
    },
    Subscribe {
        socket: String,
        channel: ChannelRef,
        after_seq: i64,
    },
    Unsubscribe {
        socket: String,
        channel: ChannelRef,
    },
    Post(PostSpec),
    HoldReplay {
        channel: ChannelRef,
    },
    AwaitReplayHeld {
        channel: ChannelRef,
    },
    ReleaseReplay {
        channel: ChannelRef,
    },
    RemoveMembership {
        member: String,
        channel: ChannelRef,
    },
    SignOut {
        member: String,
    },
    History(HistorySpec),
    MainTimeline(TimelineSpec),
    MarkRead {
        #[serde(rename = "as")]
        member: String,
        channel: ChannelRef,
        topic_name: Option<String>,
        read_seq: i64,
        expect_read_seq: i64,
    },
    Unread {
        #[serde(rename = "as")]
        member: String,
        channel: ChannelRef,
        expect: UnreadExpectation,
    },
    ReplyChain(ReplyChainSpec),
    Expect {
        socket: String,
        events: Vec<Event>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PostSpec {
    #[serde(rename = "as")]
    pub member: String,
    pub channel: ChannelRef,
    #[serde(default = "one")]
    pub count: usize,
    #[serde(default)]
    pub concurrent: bool,
    pub key: Option<String>,
    pub label: Option<String>,
    pub topic_name: Option<String>,
    pub reply_to: Option<String>,
    #[serde(default = "created")]
    pub expect_status: u16,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HistorySpec {
    #[serde(rename = "as")]
    pub member: String,
    pub channel: ChannelRef,
    pub query: std::collections::BTreeMap<String, i64>,
    pub expect: HistoryExpectation,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HistoryExpectation {
    pub status: u16,
    pub seqs: Option<Vec<Seq>>,
    pub has_more: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TimelineSpec {
    #[serde(rename = "as")]
    pub member: String,
    pub channel: ChannelRef,
    pub query: std::collections::BTreeMap<String, i64>,
    pub expect: TimelineExpectation,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TimelineExpectation {
    pub status: u16,
    pub as_of_seq: i64,
    pub items: Vec<TimelineItem>,
    pub has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum TimelineItem {
    Message { message: TimelineMessage },
    Topic { topic: TimelineTopic },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TimelineMessage {
    pub seq: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TimelineTopic {
    pub name: String,
    pub last_seq: i64,
    pub message_count: i64,
    #[serde(default)]
    pub read_seq: i64,
    #[serde(default)]
    pub unread_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UnreadExpectation {
    pub read_seq: i64,
    pub main_unread_count: i64,
    pub unread_count: i64,
    pub topic_counts: std::collections::BTreeMap<String, UnreadTopic>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UnreadTopic {
    pub read_seq: i64,
    pub unread_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Event {
    Message {
        channel: ChannelRef,
        seqs: Option<Vec<Seq>>,
        from_post: Option<String>,
    },
    Subscribed {
        channel: ChannelRef,
        caught_up_seq: i64,
    },
    Error {
        channel: Option<ChannelRef>,
        code: String,
    },
    Closed {
        code: u16,
    },
    Silent {
        barrier: Barrier,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Barrier {
    pub channel: String,
    pub caught_up_seq: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReplyChainSpec {
    #[serde(rename = "as")]
    pub member: String,
    pub channel: ChannelRef,
    pub anchor: String,
    pub query: std::collections::BTreeMap<String, i64>,
    pub expect: ReplyChainExpectation,
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReplyChainExpectation {
    pub status: u16,
    pub root: String,
    pub seqs: Vec<Seq>,
    pub has_more: bool,
}
