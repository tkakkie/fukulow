use crate::{
    AppState,
    auth::{ApiError, Auth},
    channels,
};
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use utoipa::ToSchema;
use uuid::Uuid;

use super::counts::{ListCounts, MissingPositionLog, list_counts};
#[cfg(test)]
use crate::messages::tests;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct UnreadChannel {
    pub history_generation: Uuid,
    #[serde(flatten)]
    pub channel: channels::Channel,
    /// Latest committed Channel seq in the positions/counts snapshot; 0 if empty.
    pub as_of_seq: i64,
    /// Current Member position for Messages without Topic; independent of as_of_seq.
    pub read_seq: i64,
    /// Other senders' Messages without Topic above read_seq, bounded by as_of_seq.
    pub main_unread_count: i64,
    /// Channel badge: main-timeline Unread plus all Topic Unread, bounded by as_of_seq.
    pub unread_count: i64,
    #[schema(minimum = 0)]
    pub main_mention_unread_count: i64,
    #[schema(minimum = 0)]
    pub mention_unread_count: i64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ChannelList {
    pub history_generation: Uuid,
    pub channels: Vec<UnreadChannel>,
}

pub(super) async fn visible_channels(
    state: &AppState,
    auth: &Auth,
    archived: bool,
    requested_generation: Option<Uuid>,
) -> Result<ChannelList, ApiError> {
    crate::database::organization_read_only(
        &state.pool,
        auth.identity.organization.organization_id,
        async |tx: &mut PgConnection| {
            let channels = channels::visible_list(&mut *tx, auth, Some(archived)).await?;
            #[cfg(test)]
            tests::unread::baseline::pause_list(auth.identity.member.id).await;
            let history_generation = crate::auth::history::validate(
                tx,
                auth.identity.organization.organization_id,
                requested_generation,
            )
            .await?;
            let ids = channels.iter().map(|c| c.id).collect::<Vec<_>>();
            // Two batched queries in one authorization/data snapshot, independent of the
            // number of Channels or Topics. No Message or position outside ids is read.
            let mut counts = list_counts(tx, auth, &ids, MissingPositionLog::Emit).await?;
            let mut result = Vec::with_capacity(channels.len());
            for channel in channels {
                let ListCounts {
                    as_of_seq,
                    read_seq,
                    main_unread_count,
                    unread_count,
                    main_mention_unread_count,
                    mention_unread_count,
                } = counts.remove(&channel.id).ok_or(sqlx::Error::RowNotFound)?;
                result.push(UnreadChannel {
                    channel,
                    history_generation,
                    as_of_seq,
                    read_seq,
                    main_unread_count,
                    unread_count,
                    main_mention_unread_count,
                    mention_unread_count,
                });
            }
            Ok(ChannelList {
                history_generation,
                channels: result,
            })
        },
    )
    .await
}
