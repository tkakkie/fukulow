use axum::{
    Json,
    extract::{
        Path, Query, State,
        rejection::{PathRejection, QueryRejection},
    },
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{ApiError, ApiJson, Auth, DeferredOrganizationAuth, ErrorBody},
    channels,
};

mod admission;
pub mod authors;
mod commit;
mod delivery;
pub mod dms;
mod error;
pub use error::MessageError;
use error::dm_error;
mod failure;
mod guards;
use guards::{check_visibility, reject_dm_topics, reject_dm_topics_scoped};
pub(crate) use guards::{require_visible, require_visible_scoped};
pub(crate) mod history;
mod limiter;
pub(crate) mod list;
pub use list::list_messages;
pub(crate) mod log;
pub(crate) use log::ChannelEvent;
pub use log::list_channel_events;
mod mentions;
pub(crate) mod move_topic;
pub use move_topic::move_chain;
mod page;
use page::valid_page_limit;
pub mod reactions;
pub mod receipts;
mod response;
pub use fukulow_api::{ListMessagesQuery, Mention, Message, MessagePage, SendMessageRequest};
pub use limiter::SendLimit;
use response::no_store_json;
pub(crate) mod replies;
pub use replies::counts::{ReplyCount, ReplyCountPage, ReplyCountRequest, reply_counts};
pub use replies::{ReplyChainPage, ReplyChainQuery, reply_chain};
mod row;
use row::{message_columns, message_from_row};
pub mod search;
pub(crate) mod send;
pub use send::send_message;
#[cfg(test)]
use send::{ValidateSendMessage, committed, existing, persist};
pub(crate) mod topics;
pub(crate) mod unread;
mod watermark;
#[cfg(test)]
pub(crate) use commit::{ambiguous_commit, pause_commit};
pub use delivery::Delivery;
pub(crate) use delivery::LIVE_QUEUE_CAPACITY;
#[cfg(test)]
pub(crate) use delivery::{
    MAX_IN_FLIGHT_NOTIFICATIONS, MAX_ORGANIZATION_NOTIFICATIONS, NOTIFICATION_TIMEOUT,
    pause_publication,
};
pub use topics::{
    ListProjectionQuery, TimelineItem, TimelinePage, TopicPage, TopicSummary, TopicSummaryResponse,
    list_timeline, list_topics, topic_history, topic_summary,
};
pub use unread::{
    ChannelList, MarkReadRequest, ReadPosition, UnreadChannel, list_channels, mark_channel_read,
    mark_topic_read,
};

trait ValidateListMessages {
    fn validate(&self) -> Result<u16, MessageError>;
}

impl ValidateListMessages for ListMessagesQuery {
    fn validate(&self) -> Result<u16, MessageError> {
        let limit = self.limit.unwrap_or(50);
        if (self.after_seq.is_some() && self.before_seq.is_some())
            || self.as_of_seq.is_some_and(|seq| seq < 0)
            || self.after_seq.is_some_and(|seq| seq < 0)
            || self.before_seq.is_some_and(|seq| seq < 1)
            || !valid_page_limit(limit)
        {
            return Err(MessageError::InvalidInput);
        }
        Ok(limit)
    }
}

pub(crate) use delivery::{LiveMessage, LiveQueue};

const REPLAY_PAGE_SIZE: i64 = 50;

pub(crate) use log::{authorized_replay_page, replay_page};

#[cfg(test)]
mod tests;
