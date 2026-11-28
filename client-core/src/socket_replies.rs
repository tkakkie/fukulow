//! Attribute wire replies that carry a Channel ID but no subscription ID.
use crate::{Availability, ChannelView, Core, Token};
use fukulow_api::ServerEvent;
use std::collections::{BTreeMap, VecDeque};
use uuid::Uuid;

#[cfg(test)]
mod tests;

#[derive(Default)]
pub(super) struct SocketReplies(BTreeMap<Uuid, Issuances>);

#[derive(Default)]
struct Issuances {
    pending: VecDeque<Token>,
    confirmed: Option<Token>,
}

pub(super) enum Route {
    Sync(Option<Token>),
    Activity,
    Reconnect,
}

#[derive(PartialEq, Eq)]
enum Reply {
    Subscribed,
    AccessLost,
    ChannelNotFound,
    SubscriptionLimit,
}

impl Core {
    /// Record the control immediately before the transport sends it, even if its watch has retired.
    pub fn subscribe_issued(&mut self, connection: Token, channel: Uuid, id: Token) {
        if self.session.connection == Some(connection) && self.session.connected {
            self.socket_replies
                .0
                .entry(channel)
                .or_default()
                .pending
                .push_back(id);
        }
    }
}

impl SocketReplies {
    pub(super) fn clear(&mut self) {
        self.0.clear();
    }

    pub(super) fn route(
        &mut self,
        event: &ServerEvent,
        channels: &BTreeMap<Uuid, ChannelView>,
    ) -> Route {
        let (id, reply) = match event {
            ServerEvent::Subscribed { channel_id, .. } => (*channel_id, Reply::Subscribed),
            ServerEvent::ChannelAccessLost { channel_id } => (*channel_id, Reply::AccessLost),
            ServerEvent::Error {
                channel_id: Some(id),
                code,
            } => match code.as_str() {
                "channel_not_found" => (*id, Reply::ChannelNotFound),
                "subscription_limit" => (*id, Reply::SubscriptionLimit),
                _ => return Route::Sync(None),
            },
            ServerEvent::Error { .. } | ServerEvent::Message { .. } | ServerEvent::Move(_) => {
                return Route::Sync(None);
            }
            ServerEvent::ActivityReady
            | ServerEvent::ActivityReset
            | ServerEvent::ChannelListChanged
            | ServerEvent::DmListChanged
            | ServerEvent::MembersChanged
            | ServerEvent::SectionsChanged { .. }
            | ServerEvent::ChannelActivity { .. }
            | ServerEvent::ReadPositionChanged { .. }
            | ServerEvent::ChannelAccessGained { .. }
            | ServerEvent::ChannelAccessRevoked { .. }
            | ServerEvent::ChannelMembersChanged { .. } => return Route::Activity,
        };

        let mut issuances = self.0.get_mut(&id);
        let pending = issuances.as_ref().is_some_and(|i| !i.pending.is_empty());
        let confirmed = issuances.as_ref().and_then(|i| i.confirmed);
        let loss = matches!(reply, Reply::AccessLost | Reply::ChannelNotFound);
        // A confirmed generation and a queued subscribe can both explain an untagged loss.
        // Channel-only access loss also needs a matching confirmation. A new subscribed
        // handoff ends the ambiguity because the server serializes controls and live delivery.
        if loss
            && channels.get(&id).is_some_and(|c| {
                let overlapping_generations = confirmed.is_some() && pending;
                let unconfirmed_loss = reply == Reply::AccessLost
                    && c.state != Availability::Unavailable
                    && (confirmed.is_none() || confirmed != c.subscription.as_ref().map(|s| s.id));
                c.watched && (overlapping_generations || unconfirmed_loss)
            })
        {
            return Route::Reconnect;
        }

        let mut paired = issuances.as_mut().and_then(|i| i.pending.pop_front());
        if let Some(issuances) = issuances {
            if loss {
                paired = paired.or(issuances.confirmed.take());
            } else if reply == Reply::Subscribed && paired.is_some() {
                issuances.confirmed = paired;
            }
        }

        // An unpaired reply must fail the existing subscription ID check. Ordinary
        // events above have no attribution and follow their existing transitions.
        const UNATTRIBUTED_REPLY: Token = -1;
        Route::Sync(Some(paired.unwrap_or(UNATTRIBUTED_REPLY)))
    }
}
