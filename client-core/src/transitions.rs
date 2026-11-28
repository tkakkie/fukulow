use crate::{
    engine::Step,
    history_generation::{ChannelHistory, is_generation_conflict},
    merge::Source,
    socket_replies::Route,
    *,
};
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
                // This token survives ordinary reconnects. Only a Session or history reset replaces it.
                self.core.organization_history_issue = self.core.session.connection;
                self.direct = true;
                self.force_changed = true;
            }
            Input::Stop => {
                self.stop(false);
                self.direct = true;
                self.force_changed = true;
            }
            Input::OrganizationUnavailable => self.organization_unavailable(),
            Input::ObserveHistoryGeneration {
                channel,
                issue,
                lifetime,
                result,
            } => {
                let decision = self.observe_history_generation(channel, issue, lifetime, result);
                // A non-reset observation only reads or updates generation metadata.
                self.direct = decision != HistoryObservationResult::Reset;
                self.out.history_observation = Some(decision);
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
    pub(super) fn organization_unavailable(&mut self) {
        if !self.core.session.running {
            return;
        }
        self.teardown();
        self.core.channel_history.clear();
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
                self.out.history_observation = Some(match generation {
                    Some(generation) if self.accept_generation(generation) => {
                        HistoryObservationResult::Accepted
                    }
                    Some(_) => HistoryObservationResult::Reset,
                    None => {
                        self.reset_history(None);
                        HistoryObservationResult::Reset
                    }
                });
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
            Input::SocketClosed { connection, code } => self.socket_closed(connection, code, false),
            Input::SocketDisconnected {
                connection,
                code,
                opened,
                opaque,
            } => {
                if self.core.session.connection != Some(connection) {
                    return;
                }
                if !opened && opaque {
                    self.core.membership_probe_pending = true;
                    self.out
                        .effects
                        .push(Effect::CheckMembership { connection });
                } else {
                    self.socket_closed(connection, code, true);
                }
            }
            Input::MembershipChecked {
                connection,
                status,
                error,
            } => self.membership_checked(
                connection,
                status.as_ref().and_then(Failure::http_status),
                error.as_deref(),
            ),
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
                let needs_history = c.cursor.is_none();
                let empty = c.messages.is_empty();
                self.core.channel_history.insert(
                    id,
                    ChannelHistory {
                        issue: n,
                        generation: None,
                    },
                );
                if needs_history {
                    self.history(id, Page::Latest, None);
                } else {
                    if empty {
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
                self.core.channel_history.remove(&id);
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
            Input::SocketFrame { connection, event } => self.socket_frame(connection, event),
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
                if self.core.requests.get(&request).is_some_and(|r| !r.stale()) {
                    if is_generation_conflict(status.http_status(), error.as_deref()) {
                        self.core.requests.remove(&request);
                        self.reset_history(None);
                        return;
                    }
                    if status == Failure::Status(409)
                        && error.as_deref() == Some("snapshot_expired")
                    {
                        if let Some(Request::History { channel, page, .. }) =
                            self.core.requests.remove(&request)
                        {
                            self.expire_window(channel, page != Page::Latest);
                        }
                        return;
                    }
                }
                self.history_response(request, Err((status, error.as_deref())));
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
    fn socket_closed(&mut self, connection: Token, code: u16, report_organization: bool) {
        if self.core.session.connection != Some(connection) {
            return;
        }
        if code == 4003 {
            if report_organization {
                self.out
                    .effects
                    .push(Effect::ReportOrganizationUnavailable {
                        socket: Some(ClosedSocket { connection, code }),
                    });
            } else {
                self.organization_unavailable();
            }
            return;
        }
        self.finish_socket_close(code == 4001);
    }

    fn membership_checked(&mut self, connection: Token, status: Option<u16>, error: Option<&str>) {
        if self.core.session.connection != Some(connection) || !self.core.membership_probe_pending {
            return;
        }
        self.core.membership_probe_pending = false;
        match access_outcome(
            AccessEndpoint::Organization,
            AccessLifetime::Current,
            status,
            error,
        ) {
            AccessOutcome::OrganizationUnavailable => {
                self.out
                    .effects
                    .push(Effect::ReportOrganizationUnavailable { socket: None });
            }
            AccessOutcome::AccountEnded => self.finish_socket_close(true),
            _ => self.finish_socket_close(false),
        }
    }

    fn finish_socket_close(&mut self, account_ended: bool) {
        self.core.session.connection = None;
        self.core.session.connected = false;
        self.core.membership_probe_pending = false;
        self.core.socket_replies.clear();
        for id in self.ids() {
            if self
                .core
                .channel(id)
                .is_some_and(|c| c.subscription.is_some())
            {
                self.channel(id).subscription = None;
            }
        }
        if account_ended {
            self.stop(true);
            return;
        }
        let attempt = self.core.session.reconnect_attempt;
        self.core.session.reconnect_attempt += 1;
        let n = self.wait(Purpose::ReconnectBackoff, None, attempt);
        self.core.session.reconnect_wait = Some(n);
    }

    fn socket_frame(&mut self, connection: Token, event: ServerEvent) {
        if self.core.session.connection != Some(connection) {
            self.direct = true;
            return;
        }
        match self.core.socket_replies.route(&event, &self.core.channels) {
            Route::Sync(subscription) => {
                self.event(connection, event, subscription);
                self.out.socket_delivery = Some(SocketDelivery::Sync { subscription });
            }
            Route::Activity => {
                self.direct = true;
                self.out.socket_delivery = Some(SocketDelivery::Activity);
            }
            Route::Reconnect if self.core.session.connected => {
                self.finish_socket_close(false);
                self.out
                    .effects
                    .push(Effect::CloseConnection { connection });
            }
            _ => self.direct = true,
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
                    self.restart_channel_history(id, None);
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
