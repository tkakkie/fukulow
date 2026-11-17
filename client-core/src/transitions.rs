use crate::{engine::Step, merge::Source, *};
use fukulow_api::ServerEvent;
use std::rc::Rc;

impl Step<'_> {
    pub fn run(mut self, input: StepInput) -> StepResult {
        self.refresh_mentions = input.refresh_mention_names;
        match input.input {
            Input::SessionStart { self_id } | Input::SessionReplaced { self_id } => {
                if self.core.session.running {
                    self.stop(false);
                } else {
                    self.clear_channels();
                }
                let next = self.core.session.next;
                self.core.session = Core::new(self_id).session;
                self.core.session.next = next;
                self.core.session.running = true;
                self.core.requests.clear();
                self.core.timers.clear();
                self.connect();
                self.direct = true;
                self.force_changed = true;
            }
            Input::Stop => {
                self.stop(false);
                self.direct = true;
                self.force_changed = true;
            }
            Input::OrganizationUnavailable => self.organization_unavailable(),
            Input::SocketClosed {
                connection,
                code: 4003,
            } if self.core.session.connection == Some(connection) => {
                self.organization_unavailable()
            }
            Input::UserDiscard {
                channel,
                client_message_id,
            } if self.core.session.running
                || self.core.session.organization == Organization::Unavailable =>
            {
                if let Some(c) = self.core.channel(channel)
                    && c.pending.iter().any(|p| {
                        p.client_message_id == client_message_id && p.state != PendingState::Sending
                    })
                {
                    let pending = c.pending.clone();
                    for p in pending
                        .iter()
                        .filter(|p| p.client_message_id == client_message_id)
                    {
                        self.cancel(p.retry_wait);
                    }
                    self.channel(channel).pending = Rc::new(
                        pending
                            .iter()
                            .filter(|p| {
                                p.client_message_id != client_message_id
                                    || p.state == PendingState::Sending
                            })
                            .cloned()
                            .collect(),
                    );
                }
            }
            input if self.core.session.running => self.running(input),
            _ => {}
        }
        self.finish()
    }
    fn organization_unavailable(&mut self) {
        if !self.core.session.running {
            return;
        }
        let timers: Vec<_> = self.core.timers.keys().copied().collect();
        for id in timers {
            self.cancel(Some(id));
        }
        self.core.session.organization = Organization::Unavailable;
        self.core.session.running = false;
        self.core.session.connected = false;
        self.core.session.connection = None;
        self.core.requests.clear();
        self.metadata_changed = true;
        for id in self.ids() {
            let c = self.channel(id);
            c.state = Availability::Unavailable;
            c.subscription = None;
            c.pending = Rc::new(
                c.pending
                    .iter()
                    .map(|p| {
                        let mut p = p.clone();
                        p.state = PendingState::Failed;
                        p.retry_wait = None;
                        p
                    })
                    .collect(),
            );
        }
        self.out.effects.push(Effect::Close);
    }
    fn running(&mut self, input: Input) {
        match input {
            Input::SettleHistory { channel, messages } => {
                if self
                    .core
                    .channel(channel)
                    .is_some_and(|c| c.watched && c.state != Availability::Unavailable)
                {
                    self.merge(channel, messages, Source::Projection);
                }
            }
            Input::ConnectionReady { connection } => {
                if self.core.session.connection != Some(connection) || self.core.session.connected {
                    return;
                }
                self.core.session.connected = true;
                for id in self.ids() {
                    self.subscribe(id);
                }
            }
            Input::SocketClosed { connection, code } => {
                if self.core.session.connection != Some(connection) {
                    return;
                }
                self.core.session.connection = None;
                self.core.session.connected = false;
                for id in self.ids() {
                    if self
                        .core
                        .channel(id)
                        .is_some_and(|c| c.subscription.is_some())
                    {
                        self.channel(id).subscription = None;
                    }
                }
                if code == 4001 {
                    self.stop(true);
                    return;
                }
                let attempt = self.core.session.reconnect_attempt;
                self.core.session.reconnect_attempt += 1;
                let n = self.wait(Purpose::ReconnectBackoff, None, attempt);
                self.core.session.reconnect_wait = Some(n);
            }
            Input::Watch { channel: id } => {
                let c = self.channel(id);
                if c.watched && c.state != Availability::Unavailable {
                    return;
                }
                let n = self.token();
                let c = self.channel(id);
                c.last_used = Some(n);
                c.watched = true;
                c.history_error = false;
                if c.state == Availability::Unavailable {
                    c.state = Availability::Loading;
                    c.subscription = None;
                }
                if c.cursor.is_none() {
                    self.history(id, Page::Latest, None);
                } else {
                    if c.messages.is_empty() {
                        self.history(id, Page::Latest, None);
                    }
                    self.subscribe(id);
                    self.reconcile(id, false);
                }
            }
            Input::ChannelUnavailable { channel } => self.unavailable(channel),
            Input::Unwatch { channel: id } => {
                let connected = self.core.session.connected;
                let c = self.channel(id);
                if c.subscription.is_some() && connected {
                    self.out.effects.push(Effect::Unsubscribe { channel: id });
                }
                let n = self.token();
                let c = self.channel(id);
                c.watched = false;
                c.subscription = None;
                c.last_used = Some(n);
                self.invalidate(id, false);
            }
            Input::Refresh { channel: id } => {
                if self.channel(id).state == Availability::Unavailable {
                    self.channel(id).state = Availability::Loading;
                }
                self.history(id, Page::Latest, None);
            }
            Input::LoadOlder { channel: id } => {
                let c = self.channel(id);
                if c.state != Availability::Unavailable
                    && c.has_older
                    && let Some(m) = c.messages.first()
                {
                    let seq = m.created_seq;
                    self.history(id, Page::Before, Some(seq));
                }
            }
            Input::UserSend {
                channel: id,
                client_message_id,
                body,
                reply_to,
                topic_name,
                reply_root_id,
            } => {
                // ECMAScript trim includes BOM and excludes Unicode NEL.
                if body
                    .trim_matches(|ch: char| {
                        ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}')
                    })
                    .is_empty()
                    || (reply_to.is_some() && topic_name.as_ref().is_some_and(|s| !s.is_empty()))
                {
                    return;
                }
                let c = self.channel(id);
                if c.state == Availability::Unavailable
                    || c.pending
                        .iter()
                        .any(|p| p.client_message_id == client_message_id)
                {
                    return;
                }
                let reply_root_id = reply_to.map(|parent| {
                    reply_root_id
                        .or_else(|| {
                            c.messages
                                .iter()
                                .find(|m| m.id == parent)
                                .and_then(|m| m.reply_root_id)
                        })
                        .unwrap_or(parent)
                });
                self.attempt(
                    id,
                    Pending {
                        client_message_id,
                        body,
                        state: PendingState::Sending,
                        request: 0,
                        retry_wait: None,
                        failure_code: None,
                        reply_to,
                        topic_name: topic_name.filter(|s| !s.is_empty()),
                        reply_root_id,
                    },
                );
            }
            Input::UserRetry {
                channel: id,
                client_message_id,
            } => {
                let c = self.channel(id);
                if c.state != Availability::Unavailable
                    && let Some(p) = c
                        .pending
                        .iter()
                        .find(|p| {
                            p.client_message_id == client_message_id
                                && p.state == PendingState::Unknown
                        })
                        .cloned()
                {
                    self.attempt(id, p);
                }
            }
            Input::Event {
                connection,
                event,
                subscription,
            } => self.event(connection, event, subscription),
            Input::HistoryResult { request, page } => self.history_response(request, Ok(page)),
            Input::HistoryFailed { request, status } => self.history_response(request, Err(status)),
            Input::Ack { request, message } => self.send_response(request, Ok(message)),
            Input::SendFailed {
                request,
                status,
                retry_after_ms,
                error,
            } => self.send_response(request, Err((status, retry_after_ms, error))),
            Input::TimerElapsed { id } => self.timer_elapsed(id),
            _ => {}
        }
    }
    fn event(&mut self, connection: Token, event: ServerEvent, subscription: Option<Token>) {
        if self.core.session.connection != Some(connection) || !self.core.session.connected {
            return;
        }
        let id = match &event {
            ServerEvent::Message { message, .. } => message.channel_id,
            ServerEvent::Subscribed { channel_id, .. }
            | ServerEvent::ChannelAccessLost { channel_id } => *channel_id,
            ServerEvent::Error {
                channel_id: Some(id),
                ..
            } => *id,
            _ => return,
        };
        let Some(c) = self.core.channel(id) else {
            return;
        };
        let Some(sub) = c.subscription.clone() else {
            return;
        };
        if !c.watched || c.state == Availability::Unavailable {
            return;
        }
        if !matches!(event, ServerEvent::Message { .. })
            && subscription.is_some_and(|n| n != sub.id)
        {
            return;
        }
        self.channel(id);
        match event {
            ServerEvent::Message { message, seq, .. } => {
                self.merge_event(id, vec![message], Source::Stream, Some(seq));
                self.reconcile(id, false);
            }
            ServerEvent::ChannelAccessLost { .. } => self.unavailable(id),
            ServerEvent::Error { code, .. } => {
                if code == "channel_not_found" || code == "subscription_limit" {
                    self.unavailable(id);
                }
            }
            ServerEvent::Subscribed { caught_up_seq, .. } => {
                if caught_up_seq < sub.after {
                    self.out.effects.push(Effect::Unsubscribe { channel: id });
                    self.invalidate(id, true);
                    let pending = self.channel(id).pending.clone();
                    let mut pending = (*pending).clone();
                    for p in &mut pending {
                        self.cancel(p.retry_wait);
                        if matches!(p.state, PendingState::Sending | PendingState::Throttled) {
                            p.state = PendingState::Unknown;
                            p.retry_wait = None;
                        }
                    }
                    *self.channel(id) = ChannelView {
                        watched: true,
                        pending: Rc::new(pending),
                        ..ChannelView::default()
                    };
                    self.history(id, Page::Latest, None);
                } else {
                    let c = self.channel(id);
                    if !sub.confirmed || sub.watermark != caught_up_seq {
                        c.subscription = Some(Rc::new(Subscription {
                            confirmed: true,
                            watermark: caught_up_seq,
                            ..(*sub).clone()
                        }));
                    }
                    c.state = Availability::Ready;
                    c.history_error = false;
                    self.core.session.reconnect_attempt = 0;
                    self.reconcile(id, false);
                }
            }
            _ => {}
        }
    }
}
