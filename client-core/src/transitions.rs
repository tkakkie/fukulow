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
                self.user_discard(channel, client_message_id)
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
        self.teardown();
        self.core.session.organization = Organization::Unavailable;
        for id in self.ids() {
            let c = self.channel(id);
            c.state = Availability::Unavailable;
            c.subscription = None;
            let pending = c.pending.clone();
            self.channel(id).pending = self.fail_pending_sends(&pending);
        }
    }
    fn running(&mut self, input: Input) {
        match input {
            Input::HistoryGeneration { generation } => {
                if let Some(generation) = generation {
                    self.accept_generation(generation);
                } else {
                    self.reset_history(None);
                }
            }
            Input::SettleHistory { channel, messages } => {
                if self
                    .core
                    .channel(channel)
                    .is_some_and(|c| c.watched && c.state != Availability::Unavailable)
                {
                    if messages
                        .first()
                        .is_some_and(|m| !self.accept_generation(m.history_generation))
                    {
                        return;
                    }
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
            } => self.user_send(
                id,
                client_message_id,
                body,
                reply_to,
                topic_name,
                reply_root_id,
            ),
            Input::UserRetry {
                channel: id,
                client_message_id,
            } => self.user_retry(id, client_message_id),
            Input::Event {
                connection,
                event,
                subscription,
            } => self.event(connection, event, subscription),
            Input::HistoryResult { request, page } => {
                self.history_response(request, Ok(crate::responses::HistoryPage::Messages(page)))
            }
            Input::EventsResult { request, page } => {
                self.history_response(request, Ok(crate::responses::HistoryPage::Events(page)))
            }
            Input::HistoryFailed {
                request,
                status,
                error,
            } => {
                if self.core.requests.get(&request).is_some_and(|r| !r.stale())
                    && status == Failure::Status(409)
                {
                    match error.as_deref() {
                        Some("history_generation_changed") => {
                            self.core.requests.remove(&request);
                            self.reset_history(None);
                            return;
                        }
                        Some("snapshot_expired") => {
                            if let Some(Request::History { channel, page, .. }) =
                                self.core.requests.remove(&request)
                            {
                                self.expire_window(channel, page != Page::Latest);
                            }
                            return;
                        }
                        _ => {}
                    }
                }
                self.history_response(request, Err(status));
            }
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
            ServerEvent::Move(event) => event.channel_id,
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
        if !matches!(event, ServerEvent::Message { .. } | ServerEvent::Move(_))
            && subscription.is_some_and(|n| n != sub.id)
        {
            return;
        }
        self.channel(id);
        match event {
            ServerEvent::Message { message, seq, kind } => {
                if !self.accept_generation(message.history_generation) {
                    return;
                }
                if Self::envelope_consistent(kind, seq, &message) {
                    self.merge_event(id, vec![message], Source::Stream, Some(seq));
                    self.reconcile(id, false);
                }
            }
            ServerEvent::Move(event) => {
                if self.accept_generation(event.history_generation) {
                    self.merge_move(event, Source::Stream);
                    self.reconcile(id, false);
                }
            }
            ServerEvent::ChannelAccessLost { .. } => self.unavailable(id),
            ServerEvent::Error { code, .. } => {
                if code == "history_generation_changed" {
                    self.reset_history(None);
                    return;
                }
                if code == "channel_not_found" || code == "subscription_limit" {
                    self.unavailable(id);
                }
            }
            ServerEvent::Subscribed {
                history_generation,
                caught_up_seq,
                ..
            } => {
                if !self.accept_generation(history_generation) {
                    return;
                }
                if caught_up_seq < sub.after {
                    self.out.effects.push(Effect::Unsubscribe { channel: id });
                    self.invalidate(id, true);
                    let pending = self.channel(id).pending.clone();
                    let pending = self.interrupt_pending_sends(&pending);
                    *self.channel(id) = ChannelView {
                        watched: true,
                        pending,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unhandled_history_conflicts_use_the_ordinary_failure_path() {
        let channel = Uuid::from_u128(1);
        let self_id = Uuid::from_u128(2);
        let step = |core: &mut Core, input| {
            core.step(StepInput {
                input,
                refresh_mention_names: false,
            })
        };

        for (stale, error) in [
            (true, Some("history_generation_changed")),
            (true, Some("snapshot_expired")),
            (false, Some("unknown_conflict")),
            (false, None),
        ] {
            let mut core = Core::new(self_id);
            step(&mut core, Input::SessionStart { self_id });
            step(&mut core, Input::Watch { channel });
            let request = core.channel(channel).unwrap().latest.unwrap();
            if stale {
                step(&mut core, Input::Unwatch { channel });
            }
            assert_eq!(core.request(request).unwrap().stale(), stale);

            let result = step(
                &mut core,
                Input::HistoryFailed {
                    request,
                    status: Failure::Status(409),
                    error: error.map(str::to_owned),
                },
            );

            let case = format!("stale={stale}, error={error:?}");
            assert!(core.request(request).is_none(), "{case}");
            assert_eq!(core.session().history_epoch, 0, "{case}");
            assert!(result.effects.is_empty(), "{case}");
            let view = core.channel(channel).unwrap();
            assert_eq!(view.latest, None, "{case}");
            assert_eq!(view.history_error, !stale, "{case}");
        }
    }
}
