mod heartbeat;

#[cfg(test)]
use super::tests::hooks::{self, Phase};
use super::{CLOSE_QUEUE_OVERFLOW, ClientMessage, ServerEvent};
use crate::{
    AppState,
    auth::Auth,
    channels::{AccessWatch, activity::Registration},
    database::InternalError,
    messages::{self, LIVE_QUEUE_CAPACITY, LiveQueue, MessageError},
};
use axum::extract::ws::{Message as Frame, WebSocket};
use heartbeat::Heartbeat;
use std::{collections::HashMap, time::Duration};
use uuid::Uuid;

const MAX_SUBSCRIPTIONS: usize = 256;

fn database_failure(operation: &'static str, error: &sqlx::Error) -> u16 {
    tracing::info_span!(target: "fukulow", "database", operation)
        .in_scope(|| crate::observability::database_failure(error));
    1011
}

fn internal_failure(operation: &'static str, error: &InternalError) -> u16 {
    tracing::info_span!(target: "fukulow", "database", operation)
        .in_scope(|| crate::report_internal_failure(error));
    1011
}

enum SubscriptionVisibility {
    Visible(Uuid),
    HistoryGenerationChanged,
    NotFound,
}

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
    state: &'a AppState,
    auth: &'a Auth,
    pub(super) queue: LiveQueue,
    cursors: HashMap<Uuid, i64>,
    access: HashMap<Uuid, AccessWatch>,
    permit: super::limits::Permit,
}

impl<'a> Connection<'a> {
    pub(super) fn new(state: &'a AppState, auth: &'a Auth, permit: super::limits::Permit) -> Self {
        Self {
            state,
            auth,
            queue: state.message_delivery.queue(
                auth.identity.organization.organization_id,
                (auth.identity.member.id, auth.membership_revision),
                LIVE_QUEUE_CAPACITY,
            ),
            cursors: HashMap::new(),
            access: HashMap::new(),
            permit,
        }
    }

    async fn protected_event(
        &mut self,
        socket: &mut WebSocket,
        channel: Uuid,
        event: ServerEvent,
    ) -> Result<bool, u16> {
        let Some(watch) = self.access.get(&channel) else {
            return Ok(false);
        };
        match watch
            .handoff(async {
                #[cfg(test)]
                if matches!(event, ServerEvent::Message { .. } | ServerEvent::Move(_)) {
                    self.state
                        .message_delivery
                        .message_serializations
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                Self::event(socket, event).await
            })
            .await
        {
            Some(result) => {
                result?;
                Ok(true)
            }
            None => self.protected(socket, channel).await,
        }
    }

    async fn protected_frame(
        &mut self,
        socket: &mut WebSocket,
        channel: Uuid,
        frame: axum::extract::ws::Utf8Bytes,
    ) -> Result<bool, u16> {
        let Some(watch) = self.access.get(&channel) else {
            return Ok(false);
        };
        match watch.handoff(Self::send(socket, Frame::Text(frame))).await {
            Some(result) => {
                result?;
                Ok(true)
            }
            None => self.protected(socket, channel).await,
        }
    }
    async fn protected(&mut self, socket: &mut WebSocket, channel: Uuid) -> Result<bool, u16> {
        match self.access.get(&channel).map(|watch| watch.status()) {
            Some(AccessWatch::ACTIVE) => Ok(true),
            Some(AccessWatch::CHANNEL_LOST) => {
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
            Some(AccessWatch::MEMBERSHIP_LOST) => Err(super::CLOSE_ORGANIZATION_UNAVAILABLE),
            Some(AccessWatch::RECHECK_FAILED) => Err(1011),
            None => Ok(false),
        }
    }
    async fn refresh(&mut self, socket: &mut WebSocket, channel: Uuid) -> Result<bool, u16> {
        if let Some(watch) = self.access.get(&channel) {
            #[cfg(test)]
            hooks::pause(channel, Phase::Refresh, 0).await;
            watch
                .refresh(&self.state.pool)
                .await
                .map_err(|error| database_failure("websocket_refresh", &error))?;
        }
        self.protected(socket, channel).await
    }
    async fn retire_lost(&mut self, socket: &mut WebSocket) -> Result<(), u16> {
        let lost: Vec<_> = self
            .access
            .iter()
            .filter(|(_, watch)| watch.status() != AccessWatch::ACTIVE)
            .map(|(id, _)| *id)
            .collect();
        for channel in lost {
            self.protected(socket, channel).await?;
        }
        Ok(())
    }
    async fn access_changed(access: &mut HashMap<Uuid, AccessWatch>) {
        if access
            .values()
            .any(|watch| watch.status() != AccessWatch::ACTIVE)
        {
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
        message: std::sync::Arc<messages::LiveMessage>,
    ) -> Result<(), u16> {
        #[cfg(test)]
        hooks::pause(message.channel_id, Phase::Live, message.seq).await;
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
            .protected_frame(socket, message.channel_id, message.frame.clone())
            .await?
        {
            return Ok(());
        }
        self.cursors.insert(message.channel_id, message.seq);
        Ok(())
    }

    async fn event(socket: &mut WebSocket, event: ServerEvent) -> Result<(), u16> {
        Self::send(socket, Self::event_frame(&event)?).await
    }

    pub(super) fn event_frame(event: &ServerEvent) -> Result<Frame, u16> {
        let json = serde_json::to_string(event).map_err(|_| 1011u16)?;
        Ok(Frame::Text(json.into()))
    }

    pub(super) async fn send(socket: &mut WebSocket, frame: Frame) -> Result<(), u16> {
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

    async fn visible(
        &self,
        channel: Uuid,
        generation: Option<Uuid>,
    ) -> Result<SubscriptionVisibility, u16> {
        match messages::history::authorized_generation(
            &self.state.pool,
            self.auth.identity.organization.organization_id,
            (self.auth.identity.member.id, self.auth.membership_revision),
            channel,
            generation,
        )
        .await
        {
            Ok(generation) => Ok(SubscriptionVisibility::Visible(generation)),
            Err(MessageError::HistoryGenerationChanged) => {
                Ok(SubscriptionVisibility::HistoryGenerationChanged)
            }
            Err(MessageError::NotFound) => Ok(SubscriptionVisibility::NotFound),
            Err(MessageError::OrganizationUnavailable) => {
                Err(super::CLOSE_ORGANIZATION_UNAVAILABLE)
            }
            Err(MessageError::Internal(error)) => {
                Err(internal_failure("websocket_authorize", &error))
            }
            Err(_) => Err(1011),
        }
    }

    // Subscription replay also handles a cursor gap after access was lost and restored.
    // Concurrent publication reordering is recovered once by the Channel publisher.
    async fn catch_up(&mut self, socket: &mut WebSocket, channel: Uuid) -> Result<(), u16> {
        let Some(mut after) = self.cursors.get(&channel).copied() else {
            return Ok(());
        };
        let organization = self.auth.identity.organization.organization_id;
        #[cfg(test)]
        self.state.message_delivery.record_watermark_caller(
            &self.state.pool,
            organization,
            channel,
            "initial",
        );
        let through = self
            .state
            .message_delivery
            .latest_seq(&self.state.pool, organization, channel)
            .await
            .map_err(|error| internal_failure("websocket_latest_seq", &error))?;
        if !self.refresh(socket, channel).await? {
            return Ok(());
        }
        after = after.min(through);
        self.cursors.insert(channel, after);
        #[cfg(test)]
        hooks::pause_replay(channel).await;
        while after < through {
            #[cfg(test)]
            hooks::pause(channel, Phase::Snapshot, after).await;
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
                Err(MessageError::Internal(error)) => {
                    return Err(internal_failure("websocket_replay", &error));
                }
                Err(_) => return Err(1011),
            };
            if page.is_empty() {
                return Err(1011);
            }
            #[cfg(test)]
            hooks::pause(channel, Phase::Page, after).await;
            for message in page {
                #[cfg(test)]
                hooks::pause(channel, Phase::Frame, message.seq).await;
                if !self.protected(socket, channel).await? {
                    return Ok(());
                }
                after = message.seq;
                if !self
                    .protected_event(socket, channel, message.into_wire())
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
            ClientMessage::Unsubscribe { channel_id } => {
                self.unsubscribe(channel_id);
                Ok(())
            }
            ClientMessage::Subscribe {
                channel_id,
                after_seq,
                history_generation,
            } => {
                if self.cursors.contains_key(&channel_id) {
                    self.subscribe_again(socket, channel_id, history_generation)
                        .await
                } else {
                    self.subscribe(socket, channel_id, after_seq, history_generation)
                        .await
                }
            }
        }
    }

    async fn subscribe_again(
        &mut self,
        socket: &mut WebSocket,
        channel_id: Uuid,
        history_generation: Option<Uuid>,
    ) -> Result<(), u16> {
        // Duplicate controls never replay or change the cursor. A carried epoch
        // still requires fresh authorization before it can be compared.
        if history_generation.is_some() {
            match self.visible(channel_id, history_generation).await? {
                SubscriptionVisibility::Visible(_) => {}
                SubscriptionVisibility::HistoryGenerationChanged => {
                    self.unsubscribe(channel_id);
                    return Self::error(socket, Some(channel_id), "history_generation_changed")
                        .await;
                }
                SubscriptionVisibility::NotFound => {
                    self.unsubscribe(channel_id);
                    return Self::error(socket, Some(channel_id), "channel_not_found").await;
                }
            }
        }
        Ok(())
    }

    async fn subscribe(
        &mut self,
        socket: &mut WebSocket,
        channel_id: Uuid,
        after_seq: i64,
        history_generation: Option<Uuid>,
    ) -> Result<(), u16> {
        if after_seq < 0 {
            return Self::error(socket, Some(channel_id), "invalid_input").await;
        }
        if self.cursors.len() >= MAX_SUBSCRIPTIONS {
            return Self::error(socket, Some(channel_id), "subscription_limit").await;
        }
        #[cfg(test)]
        hooks::pause(channel_id, Phase::Authorize, 0).await;
        match self.visible(channel_id, history_generation).await? {
            SubscriptionVisibility::Visible(_) => {}
            SubscriptionVisibility::HistoryGenerationChanged => {
                return Self::error(socket, Some(channel_id), "history_generation_changed").await;
            }
            SubscriptionVisibility::NotFound => {
                return Self::error(socket, Some(channel_id), "channel_not_found").await;
            }
        }
        #[cfg(test)]
        hooks::pause(channel_id, Phase::AccessSubscribe, 0).await;
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
            .map_err(|error| database_failure("websocket_subscribe", &error))?;
        let Some(watch) = watch else {
            return Self::error(socket, Some(channel_id), "channel_not_found").await;
        };
        self.access.insert(channel_id, watch);
        #[cfg(test)]
        hooks::pause(channel_id, Phase::Registered, 0).await;
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
        self.confirm_subscribed(socket, channel_id).await
    }

    async fn confirm_subscribed(
        &mut self,
        socket: &mut WebSocket,
        channel_id: Uuid,
    ) -> Result<(), u16> {
        if !self.refresh(socket, channel_id).await? {
            return Ok(());
        }
        #[cfg(test)]
        hooks::pause(channel_id, Phase::SubscribedSeq, 0).await;
        if let Some(&caught_up_seq) = self.cursors.get(&channel_id) {
            #[cfg(test)]
            self.state.message_delivery.record_watermark_caller(
                &self.state.pool,
                self.auth.identity.organization.organization_id,
                channel_id,
                "confirmation",
            );
            let latest = self
                .state
                .message_delivery
                .latest_seq(
                    &self.state.pool,
                    self.auth.identity.organization.organization_id,
                    channel_id,
                )
                .await
                .map_err(|error| internal_failure("websocket_subscribed_seq", &error))?;
            if !self.protected(socket, channel_id).await? {
                return Ok(());
            }
            #[cfg(test)]
            hooks::pause(channel_id, Phase::HandoffGeneration, 0).await;
            let history_generation = match self.visible(channel_id, None).await? {
                SubscriptionVisibility::Visible(generation) => generation,
                SubscriptionVisibility::NotFound => {
                    self.unsubscribe(channel_id);
                    return Self::event(socket, ServerEvent::ChannelAccessLost { channel_id })
                        .await;
                }
                // Handoff carries no expected epoch, so a mismatch here is internal.
                SubscriptionVisibility::HistoryGenerationChanged => return Err(1011),
            };
            self.protected_event(
                socket,
                channel_id,
                ServerEvent::Subscribed {
                    history_generation,
                    channel_id,
                    caught_up_seq: caught_up_seq.min(latest),
                },
            )
            .await?;
        }
        Ok(())
    }

    pub async fn run(
        &mut self,
        socket: &mut WebSocket,
        activity: Registration,
        lifecycle: Lifecycle,
    ) -> Result<(), u16> {
        #[cfg(test)]
        crate::channels::activity::test_pause(
            self.auth.identity.organization.organization_id,
            Uuid::nil(),
            "ready",
            Some(self.auth.identity.member.id),
        )
        .await;
        Self::event(socket, ServerEvent::ActivityReady).await?;
        let mut heartbeat = Heartbeat::new(lifecycle);
        loop {
            let frame = tokio::select! {
                biased;
                _ = Self::access_changed(&mut self.access) => { self.retire_lost(socket).await?; continue; },
                Some(notice) = activity.next() => {
                    Self::activity_notice(&self.state.pool, socket, notice).await?;
                    continue;
                },
                frame = socket.recv() => frame,
                _ = heartbeat.tick() => {
                    if heartbeat.idle_expired() {
                        // Replay may have delayed reading a queued pong or other client frame.
                        tokio::time::timeout(Duration::ZERO, socket.recv())
                            .await.map_err(|_| 1001u16)?
                    } else {
                        Self::send(socket, Frame::Ping(Default::default())).await?;
                        heartbeat.ping_sent();
                        continue;
                    }
                },
                Some(message) = self.queue.events.recv() => {
                    self.live(socket, message).await?;
                    continue;
                },
            };
            if matches!(frame, Some(Ok(_))) {
                heartbeat.frame_received();
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
