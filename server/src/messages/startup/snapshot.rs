use uuid::Uuid;

use crate::{
    AppState,
    auth::{Auth, members::display_identities},
};

use super::StartupTimeline;
use crate::messages::{
    ChannelList, ListProjectionQuery, MessageError, TimelineItem,
    authors::{AuthorIdentities, readable_identities},
    error::dm_error,
    topics::projection::read_timeline,
};

pub(super) async fn initial_timeline(
    state: &AppState,
    auth: &Auth,
    list: &ChannelList,
    channel_hint: Option<Uuid>,
) -> Result<Option<StartupTimeline>, MessageError> {
    let Some(channel_id) = channel_hint.or_else(|| list.channels.first().map(|row| row.channel.id))
    else {
        return Ok(None);
    };
    let listed = list.channels.iter().any(|row| row.channel.id == channel_id);
    let query = ListProjectionQuery {
        history_generation: Some(list.history_generation),
        as_of_seq: None,
        before_position: None,
        after_position: None,
        limit: None,
    };
    read_timeline(state, auth, channel_id, query, async |tx, page| {
        let senders: Vec<_> = page
            .items
            .iter()
            .map(|item| match item {
                TimelineItem::Message { message } => message.sender,
                TimelineItem::Topic { topic } => topic.latest_message.sender,
            })
            .collect();
        let authors = if senders.is_empty() {
            AuthorIdentities {
                identities: Vec::new(),
            }
        } else if listed {
            // The page already proves authorship in a readable ordinary Channel.
            let identities =
                display_identities(tx, auth.identity.organization.organization_id, &senders)
                    .await?;
            AuthorIdentities { identities }
        } else {
            // A DM page alone does not authorize the independent author lookup.
            readable_identities(tx, auth, &senders)
                .await
                .map_err(dm_error)?
        };
        Ok(Some(StartupTimeline {
            channel_id,
            page,
            authors,
        }))
    })
    .await
}
