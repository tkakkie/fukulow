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
use guards::{reject_dm_topics, reject_dm_topics_scoped};
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
pub mod reactions;
pub mod receipts;
pub use fukulow_api::{ListMessagesQuery, Mention, Message, MessagePage, SendMessageRequest};
pub use limiter::SendLimit;
pub(crate) mod replies;
pub use replies::counts::{ReplyCount, ReplyCountPage, ReplyCountRequest, reply_counts};
pub use replies::{ReplyChainPage, ReplyChainQuery, reply_chain};
pub mod search;
pub(crate) mod send;
pub use send::send_message;
#[cfg(test)]
use send::{ValidateSendMessage, committed, existing, persist};
pub(crate) mod topics;
pub(crate) mod unread;
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

fn message_from_row(row: &sqlx::postgres::PgRow) -> Result<Message, sqlx::Error> {
    use sqlx::Row;
    let deleted: bool = row.try_get("deleted")?;
    let (body, mentions) = if deleted {
        (None, None)
    } else {
        let mentions: String = row.try_get("mentions")?;
        let mentions =
            serde_json::from_str(&mentions).map_err(|error| sqlx::Error::ColumnDecode {
                index: "mentions".into(),
                source: Box::new(error),
            })?;
        (Some(row.try_get("body")?), Some(mentions))
    };
    Ok(Message {
        history_generation: row.try_get("history_generation")?,
        id: row.try_get("id")?,
        channel_id: row.try_get("channel_id")?,
        created_seq: row.try_get("seq")?,
        version: row.try_get("version")?,
        deleted,
        client_message_id: row.try_get("client_message_id")?,
        sender: row.try_get("sender")?,
        body,
        created_at: row.try_get("created_at")?,
        topic_id: row.try_get("topic_id")?,
        reply_to: row.try_get("reply_to")?,
        reply_root_id: row.try_get("reply_root_id")?,
        mentions,
    })
}

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
            || !(1..=200).contains(&limit)
        {
            return Err(MessageError::InvalidInput);
        }
        Ok(limit)
    }
}

pub(crate) use delivery::{LiveMessage, LiveQueue};

async fn latest_seq(
    pool: &sqlx::PgPool,
    organization: Uuid,
    channel: Uuid,
    permit: admission::Permit,
) -> Result<i64, sqlx::Error> {
    // A post-failure subscription must not snapshot behind an unresolved COMMIT.
    // Take a fresh READ COMMITTED snapshot *after* acquiring the shared barrier.
    let mut tx =
        commit::Transaction::begin(pool, permit, "BEGIN ISOLATION LEVEL READ COMMITTED", None)
            .await?;
    commit::lock(tx.connection()?, organization, channel, true).await?;
    let sql = "SELECT seq FROM channel_message_sequences \
                   WHERE organization_id = $1 AND channel_id = $2";
    let seq = sqlx::query_scalar::<_, i64>(sql)
        .bind(organization)
        .bind(channel)
        .fetch_optional(tx.connection()?)
        .await?
        .unwrap_or(0);
    tx.commit().await?;
    Ok(seq)
}

const REPLAY_PAGE_SIZE: i64 = 50;

pub(crate) use log::{authorized_replay_page, replay_page};

#[cfg(test)]
mod tests;
