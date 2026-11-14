use super::{CLOSE_QUEUE_OVERFLOW, ClientMessage, ServerEvent};
use crate::{
    AppState,
    auth::Auth,
    messages::{self, LiveQueue, MessageError},
};
use axum::extract::ws::{Message as Frame, WebSocket};
use std::{collections::HashMap, time::Duration};
use tokio::time::{Instant, MissedTickBehavior};
use uuid::Uuid;

const MAX_SUBSCRIPTIONS: usize = 256;

#[derive(Clone, Copy)]
pub(super) struct Lifecycle {
    pub ping_interval: Duration,
    pub idle_timeout: Duration,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            ping_interval: Duration::from_secs(30),
            idle_timeout: Duration::from_secs(60),
        }
    }
}

pub(super) struct Connection<'a> {
    pub state: &'a AppState,
    pub auth: &'a Auth,
    pub queue: LiveQueue,
    pub cursors: HashMap<Uuid, i64>,
    pub access: HashMap<Uuid, crate::channels::AccessWatch>,
    pub permit: super::limits::Permit,
}

impl Connection<'_> {
    async fn protected_event(
        &mut self,
        socket: &mut WebSocket,
        channel: Uuid,
        event: ServerEvent,
    ) -> Result<bool, u16> {
        let Some(watch) = self.access.get(&channel) else {
            return Ok(false);
        };
        match watch.handoff(Self::event(socket, event)).await {
            Some(result) => {
                result?;
                Ok(true)
            }
            None => self.protected(socket, channel).await,
        }
    }
    async fn protected(&mut self, socket: &mut WebSocket, channel: Uuid) -> Result<bool, u16> {
        match self.access.get(&channel).map(|watch| watch.status()) {
            Some(0) => Ok(true),
            Some(1) => {
                self.unsubscribe(channel);
                Self::event(
                    socket,
                    ServerEvent::ChannelAccessLost {
                        channel_id: channel,
                    },
                )
                .await?;
                Ok(false)
            }
            Some(3) => Err(super::CLOSE_ORGANIZATION_UNAVAILABLE),
            Some(_) => Err(1011),
            None => Ok(false),
        }
    }
    async fn refresh(&mut self, socket: &mut WebSocket, channel: Uuid) -> Result<bool, u16> {
        if let Some(watch) = self.access.get(&channel) {
            watch.refresh(&self.state.pool).await.map_err(|_| 1011u16)?;
        }
        self.protected(socket, channel).await
    }
    async fn retire_lost(&mut self, socket: &mut WebSocket) -> Result<(), u16> {
        let lost: Vec<_> = self
            .access
            .iter()
            .filter(|(_, watch)| watch.status() != 0)
            .map(|(id, _)| *id)
            .collect();
        for channel in lost {
            self.protected(socket, channel).await?;
        }
        Ok(())
    }
    async fn access_changed(access: &mut HashMap<Uuid, crate::channels::AccessWatch>) {
        if access.values().any(|watch| watch.status() != 0) {
            return;
        }
        let mut waits: Vec<_> = access
            .values_mut()
            .map(|watch| Box::pin(watch.changed.changed()))
            .collect();
        std::future::poll_fn(|cx| {
            for wait in &mut waits {
                if std::future::Future::poll(wait.as_mut(), cx).is_ready() {
                    return std::task::Poll::Ready(());
                }
            }
            std::task::Poll::Pending
        })
        .await
    }

    async fn live(
        &mut self,
        socket: &mut WebSocket,
        message: std::sync::Arc<messages::Message>,
    ) -> Result<(), u16> {
        #[cfg(test)]
        super::tests::access_loss::pause(message.channel_id, "live", message.seq).await;
        if !self.protected(socket, message.channel_id).await? {
            return Ok(());
        }
        let Some(&after) = self.cursors.get(&message.channel_id) else {
            return Ok(());
        };
        if message.seq <= after {
            return Ok(());
        }
        if after.checked_add(1) != Some(message.seq) {
            #[cfg(test)]
            self.state
                .message_delivery
                .live_refills
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return self.catch_up(socket, message.channel_id).await;
        }
        if !self
            .protected_event(
                socket,
                message.channel_id,
                ServerEvent::Message {
                    message: (*message).clone(),
                },
            )
            .await?
        {
            return Ok(());
        }
        self.cursors.insert(message.channel_id, message.seq);
        Ok(())
    }

    async fn event(socket: &mut WebSocket, event: ServerEvent) -> Result<(), u16> {
        let json = serde_json::to_string(&event).map_err(|_| 1011u16)?;
        Self::send(socket, Frame::Text(json.into())).await
    }

    async fn send(socket: &mut WebSocket, frame: Frame) -> Result<(), u16> {
        tokio::time::timeout(Duration::from_secs(5), socket.send(frame))
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
        messages::require_visible_scoped(
            &self.state.pool,
            self.auth.identity.organization.organization_id,
            (self.auth.identity.member.id, self.auth.membership_revision),
            channel,
        )
        .await
    }

    // Subscription replay also handles a cursor gap after access was lost and restored.
    // Concurrent publication reordering is recovered once by the Channel publisher.
    async fn catch_up(&mut self, socket: &mut WebSocket, channel: Uuid) -> Result<(), u16> {
        let Some(mut after) = self.cursors.get(&channel).copied() else {
            return Ok(());
        };
        let organization = self.auth.identity.organization.organization_id;
        let through = self
            .state
            .message_delivery
            .latest_seq(&self.state.pool, organization, channel)
            .await
            .map_err(|_| 1011u16)?;
        if !self.refresh(socket, channel).await? {
            return Ok(());
        }
        after = after.min(through);
        self.cursors.insert(channel, after);
        #[cfg(test)]
        super::tests::replay_gate(channel).await;
        while after < through {
            #[cfg(test)]
            super::tests::access_loss::pause(channel, "snapshot", after).await;
            let page = match messages::authorized_replay_page(
                &self.state.pool,
                organization,
                (self.auth.identity.member.id, self.auth.membership_revision),
                channel,
                after,
                through,
            )
            .await
            {
                Ok(page) => page,
                Err(MessageError::NotFound) => {
                    self.state.message_delivery.channel_access.observe_loss(
                        organization,
                        channel,
                        (self.auth.identity.member.id, self.auth.membership_revision),
                    );
                    self.protected(socket, channel).await?;
                    return Ok(());
                }
                Err(MessageError::OrganizationUnavailable) => {
                    return Err(super::CLOSE_ORGANIZATION_UNAVAILABLE);
                }
                Err(_) => return Err(1011),
            };
            if page.is_empty() {
                return Err(1011);
            }
            #[cfg(test)]
            super::tests::access_loss::pause(channel, "page", after).await;
            for message in page {
                #[cfg(test)]
                super::tests::access_loss::pause(channel, "frame", message.seq).await;
                if !self.protected(socket, channel).await? {
                    return Ok(());
                }
                after = message.seq;
                if !self
                    .protected_event(socket, channel, ServerEvent::Message { message })
                    .await?
                {
                    return Ok(());
                }
                self.cursors.insert(channel, after);
            }
        }
        Ok(())
    }

    fn unsubscribe(&mut self, channel: Uuid) {
        self.access.remove(&channel);
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
                // Already subscribed here: no authorization query, watermark, replay or
                // reply, whatever after_seq (even an invalid one). The client holds this
                // subscription's cursor; older history is REST.
                if self.cursors.contains_key(&channel_id) {
                    return Ok(());
                }
                if after_seq < 0 {
                    return Self::error(socket, Some(channel_id), "invalid_input").await;
                }
                if self.cursors.len() >= MAX_SUBSCRIPTIONS {
                    return Self::error(socket, Some(channel_id), "subscription_limit").await;
                }
                match self.visible(channel_id).await {
                    Ok(()) => {}
                    Err(MessageError::NotFound) => {
                        return Self::error(socket, Some(channel_id), "channel_not_found").await;
                    }
                    Err(MessageError::OrganizationUnavailable) => {
                        return Err(super::CLOSE_ORGANIZATION_UNAVAILABLE);
                    }
                    Err(_) => return Err(1011),
                }
                let watch = self
                    .state
                    .message_delivery
                    .channel_access
                    .subscribe(
                        &self.state.pool,
                        self.auth.identity.organization.organization_id,
                        (self.auth.identity.member.id, self.auth.membership_revision),
                        channel_id,
                    )
                    .await
                    .map_err(|_| 1011u16)?;
                let Some(watch) = watch else {
                    return Self::error(socket, Some(channel_id), "channel_not_found").await;
                };
                self.access.insert(channel_id, watch);
                #[cfg(test)]
                super::tests::access_loss::pause(channel_id, "registered", 0).await;
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
                if !self.refresh(socket, channel_id).await? {
                    return Ok(());
                }
                if let Some(&caught_up_seq) = self.cursors.get(&channel_id) {
                    let latest = self
                        .state
                        .message_delivery
                        .latest_seq(
                            &self.state.pool,
                            self.auth.identity.organization.organization_id,
                            channel_id,
                        )
                        .await
                        .map_err(|_| 1011u16)?;
                    if !self.protected(socket, channel_id).await? {
                        return Ok(());
                    }
                    self.protected_event(
                        socket,
                        channel_id,
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

    pub async fn run(&mut self, socket: &mut WebSocket, lifecycle: Lifecycle) -> Result<(), u16> {
        let activity = self
            .state
            .message_delivery
            .channel_access
            .activity
            .register(self.auth);
        Self::event(socket, ServerEvent::ActivityReady).await?;
        let mut ping_sent_at: Option<Instant> = None;
        let mut next_ping = Instant::now() + lifecycle.ping_interval;
        let mut heartbeat = tokio::time::interval_at(next_ping, lifecycle.ping_interval);
        heartbeat.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            let frame = tokio::select! {
                biased;
                _ = Self::access_changed(&mut self.access) => { self.retire_lost(socket).await?; continue; },
                Some(notice) = activity.next() => {
                    if let Some(result) = notice.handoff(Self::event(socket, notice.event.clone().into())).await { result?; }
                    continue;
                },
                frame = socket.recv() => frame,
                _ = heartbeat.tick() => {
                    if ping_sent_at.is_some_and(|sent| sent.elapsed() >= lifecycle.idle_timeout) {
                        // Replay may have delayed reading a queued pong or other client frame.
                        tokio::time::timeout(Duration::ZERO, socket.recv())
                            .await.map_err(|_| 1001u16)?
                    } else {
                        Self::send(socket, Frame::Ping(Default::default())).await?;
                        let sent = Instant::now();
                        // Replay/live work can delay this tick: grace starts only after a Ping.
                        let first_ping = *ping_sent_at.get_or_insert(sent);
                        next_ping = sent + lifecycle.ping_interval;
                        heartbeat.reset_at(next_ping.min(first_ping + lifecycle.idle_timeout));
                        continue;
                    }
                },
                Some(message) = self.queue.events.recv() => {
                    self.live(socket, message).await?;
                    continue;
                },
            };
            if matches!(frame, Some(Ok(_))) {
                ping_sent_at = None;
                heartbeat.reset_at(next_ping);
            }
            if matches!(frame, Some(Ok(Frame::Text(_) | Frame::Binary(_)))) && !self.permit.charge()
            {
                return Err(super::CLOSE_RATE_LIMITED);
            }
            match frame {
                Some(Ok(Frame::Text(text))) => match serde_json::from_str(&text) {
                    Ok(control) => self.control(socket, control).await?,
                    Err(_) => Self::error(socket, None, "invalid_input").await?,
                },
                Some(Ok(Frame::Close(_))) => {
                    // Another read flushes tungstenite's queued Close reply before EOF.
                    let _ = tokio::time::timeout(Duration::from_secs(1), socket.recv()).await;
                    return Ok(());
                }
                None | Some(Err(_)) => return Ok(()),
                Some(Ok(Frame::Binary(_))) => {
                    Self::error(socket, None, "invalid_input").await?;
                }
                _ => {}
            }
        }
    }
}
