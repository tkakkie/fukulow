use super::{CLOSE_QUEUE_OVERFLOW, ClientMessage, ServerEvent};
use crate::{
    AppState,
    auth::Auth,
    messages::{self, LiveQueue, MessageError},
};
use axum::extract::ws::{Message as Frame, WebSocket};
use std::{collections::HashMap, time::Duration};
use uuid::Uuid;

const MAX_SUBSCRIPTIONS: usize = 256;

pub(super) struct Connection<'a> {
    pub state: &'a AppState,
    pub auth: &'a Auth,
    pub queue: LiveQueue,
    pub cursors: HashMap<Uuid, i64>,
}

impl Connection<'_> {
    async fn live(
        &mut self,
        socket: &mut WebSocket,
        message: std::sync::Arc<messages::Message>,
    ) -> Result<(), u16> {
        let Some(&after) = self.cursors.get(&message.channel_id) else {
            return Ok(());
        };
        if message.seq <= after {
            return Ok(());
        }
        if after.checked_add(1) != Some(message.seq) {
            return self.catch_up(socket, message.channel_id).await;
        }
        Self::event(
            socket,
            ServerEvent::Message {
                message: (*message).clone(),
            },
        )
        .await?;
        self.cursors.insert(message.channel_id, message.seq);
        Ok(())
    }

    async fn event(socket: &mut WebSocket, event: ServerEvent) -> Result<(), u16> {
        let json = serde_json::to_string(&event).map_err(|_| 1011u16)?;
        tokio::time::timeout(
            Duration::from_secs(5),
            socket.send(Frame::Text(json.into())),
        )
        .await
        .map_err(|_| CLOSE_QUEUE_OVERFLOW)?
        .map_err(|_| 1001u16)
    }

    async fn error(
        socket: &mut WebSocket,
        channel_id: Option<Uuid>,
        code: &str,
    ) -> Result<(), u16> {
        Self::event(
            socket,
            ServerEvent::Error {
                code: code.into(),
                channel_id,
            },
        )
        .await
    }

    async fn visible(&self, channel: Uuid) -> Result<(), MessageError> {
        messages::require_visible(
            &self.state.pool,
            self.auth.identity.organization.organization_id,
            self.auth.identity.member.id,
            channel,
        )
        .await
    }

    // Notifications can race after commit. Reading the committed prefix delivers seq order
    // even when the task publishing seq N is scheduled after the task publishing N+1.
    async fn catch_up(&mut self, socket: &mut WebSocket, channel: Uuid) -> Result<(), u16> {
        let Some(mut after) = self.cursors.get(&channel).copied() else {
            return Ok(());
        };
        let organization = self.auth.identity.organization.organization_id;
        let through = messages::latest_seq(&self.state.pool, organization, channel)
            .await
            .map_err(|_| 1011u16)?;
        after = after.min(through);
        self.cursors.insert(channel, after);
        #[cfg(test)]
        super::tests::replay_gate(channel).await;
        while after < through {
            match self.visible(channel).await {
                Ok(()) => {}
                Err(MessageError::NotFound) => {
                    self.unsubscribe(channel);
                    return Self::error(socket, Some(channel), "channel_not_found").await;
                }
                Err(_) => return Err(1011),
            }
            let page =
                messages::replay_page(&self.state.pool, organization, channel, after, through)
                    .await
                    .map_err(|_| 1011u16)?;
            if page.is_empty() {
                return Err(1011);
            }
            for message in page {
                after = message.seq;
                Self::event(socket, ServerEvent::Message { message }).await?;
                self.cursors.insert(channel, after);
            }
        }
        Ok(())
    }

    fn unsubscribe(&mut self, channel: Uuid) {
        self.queue.unsubscribe(channel);
        self.cursors.remove(&channel);
    }

    async fn control(&mut self, socket: &mut WebSocket, control: ClientMessage) -> Result<(), u16> {
        match control {
            ClientMessage::Unsubscribe { channel_id } => self.unsubscribe(channel_id),
            ClientMessage::Subscribe {
                channel_id,
                after_seq,
            } => {
                if after_seq < 0 {
                    return Self::error(socket, Some(channel_id), "invalid_input").await;
                }
                if !self.cursors.contains_key(&channel_id)
                    && self.cursors.len() >= MAX_SUBSCRIPTIONS
                {
                    return Self::error(socket, Some(channel_id), "subscription_limit").await;
                }
                match self.visible(channel_id).await {
                    Ok(()) => {}
                    Err(MessageError::NotFound) => {
                        return Self::error(socket, Some(channel_id), "channel_not_found").await;
                    }
                    Err(_) => return Err(1011),
                }
                self.queue.subscribe(channel_id);
                self.cursors.insert(channel_id, after_seq);
                self.catch_up(socket, channel_id).await?;
                // Flush the bounded set queued during history. New arrivals stay queued for live.
                let queued = self.queue.events.len();
                for _ in 0..queued {
                    if let Ok(message) = self.queue.events.try_recv() {
                        self.live(socket, message).await?;
                    }
                }
                if let Some(&caught_up_seq) = self.cursors.get(&channel_id) {
                    let latest = messages::latest_seq(
                        &self.state.pool,
                        self.auth.identity.organization.organization_id,
                        channel_id,
                    )
                    .await
                    .map_err(|_| 1011u16)?;
                    Self::event(
                        socket,
                        ServerEvent::Subscribed {
                            channel_id,
                            caught_up_seq: caught_up_seq.min(latest),
                        },
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    pub async fn run(&mut self, socket: &mut WebSocket) -> Result<(), u16> {
        loop {
            tokio::select! {
                frame = socket.recv() => match frame {
                    Some(Ok(Frame::Text(text))) => match serde_json::from_str(&text) {
                        Ok(control) => self.control(socket, control).await?,
                        Err(_) => Self::error(socket, None, "invalid_input").await?,
                    },
                    Some(Ok(Frame::Close(_))) | None | Some(Err(_)) => return Ok(()),
                    Some(Ok(Frame::Binary(_))) => Self::error(socket, None, "invalid_input").await?,
                    _ => {},
                },
                Some(message) = self.queue.events.recv() => self.live(socket, message).await?,
            }
        }
    }
}
