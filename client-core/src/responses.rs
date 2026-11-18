use crate::{engine::Step, merge::Source, *};
use fukulow_api::MessagePage;
use std::rc::Rc;

pub(crate) enum HistoryPage {
    Messages(MessagePage),
    Events(fukulow_api::ChannelEventPage),
}

impl Step<'_> {
    pub(super) fn history_response(
        &mut self,
        request: Token,
        result: Result<HistoryPage, Failure>,
    ) {
        if !matches!(
            self.core.requests.get(&request),
            Some(Request::History { .. })
        ) {
            return;
        }
        let Some(Request::History {
            channel: id,
            page,
            mutation_seq,
            stale,
            ..
        }) = self.core.requests.remove(&request)
        else {
            return;
        };
        self.metadata_changed = true;
        if stale {
            if matches!(result, Err(Failure::Status(401))) {
                self.stop(true);
            }
            return;
        }
        let generation = match &result {
            Ok(HistoryPage::Messages(p)) => Some(p.history_generation),
            Ok(HistoryPage::Events(p)) => Some(p.history_generation),
            _ => None,
        };
        if generation.is_some_and(|g| !self.accept_generation(g)) {
            return;
        }
        if let Ok(HistoryPage::Messages(result)) = &result
            && result.as_of_seq < self.channel(id).mutation_seq
            && (mutation_seq < self.channel(id).mutation_seq
                || result.as_of_seq < self.channel(id).move_seq.unwrap_or_default())
        {
            let retry = page != Page::Latest || mutation_seq < self.channel(id).mutation_seq;
            let c = self.channel(id);
            c.snapshot_seq = None;
            c.latest = None;
            c.older = None;
            c.history_error = !retry;
            if retry {
                self.history(id, Page::Latest, None);
            }
            return;
        }
        let c = self.channel(id);
        match page {
            Page::Latest => c.latest = None,
            Page::Before => c.older = None,
            Page::After => c.fill = None,
        }
        match result {
            Err(Failure::Status(401)) => self.stop(true),
            Err(Failure::Status(403 | 404)) => self.unavailable(id),
            Err(_) => {
                if page == Page::After {
                    if Self::gap(c) {
                        let attempt = c.fill_attempt;
                        c.fill_attempt += 1;
                        let n = self.wait(Purpose::FillBackoff, Some(id), attempt);
                        self.channel(id).wait = Some(n);
                    }
                } else if page == Page::Latest {
                    c.history_error = true;
                }
            }
            Ok(HistoryPage::Events(result)) => {
                if page != Page::After {
                    return;
                }
                let before = c.cursor;
                for event in result.events {
                    match event {
                        fukulow_api::ServerEvent::Message { seq, kind, message }
                            if message.channel_id == id
                                && Self::envelope_consistent(kind, seq, &message) =>
                        {
                            self.merge_event(id, vec![message], Source::Events, Some(seq));
                        }
                        fukulow_api::ServerEvent::Move(event)
                            if event.channel_id == id
                                && event.history_generation == result.history_generation =>
                        {
                            self.merge_move(event, Source::Events);
                        }
                        _ => {}
                    }
                }
                let c = self.channel(id);
                if c.cursor == before && Self::gap(c) {
                    let attempt = c.fill_attempt;
                    c.fill_attempt += 1;
                    let n = self.wait(Purpose::FillBackoff, Some(id), attempt);
                    self.channel(id).wait = Some(n);
                } else {
                    c.fill_attempt = 0;
                    self.reconcile(id, true);
                }
            }
            Ok(HistoryPage::Messages(result)) => {
                let before = c.cursor;
                let bootstrap = c.cursor.is_none() && page == Page::Latest;
                if bootstrap {
                    c.cursor = Some(result.as_of_seq);
                    c.stream_base = c.cursor;
                }
                c.snapshot_seq = Some(result.as_of_seq);
                let first = result.messages.first().map(|m| m.created_seq);
                if page == Page::Latest {
                    // Release only the creation range covered by this authoritative page.
                    if !result.has_more {
                        c.retired_through = None;
                    } else if let Some(first) = first {
                        c.retired_through = c
                            .retired_through
                            .map(|through| through.min(first - 1))
                            .filter(|through| *through > 0);
                    }
                }
                self.merge(id, result.messages, Source::Window);
                let c = self.channel(id);
                if page != Page::After
                    && (page == Page::Before
                        || bootstrap
                        || c.messages.is_empty()
                        || first
                            .zip(c.messages.first())
                            .is_some_and(|(a, b)| a <= b.created_seq))
                {
                    c.has_older = result.has_more;
                }
                if bootstrap {
                    self.subscribe(id);
                }
                if page == Page::After {
                    let c = self.channel(id);
                    if c.cursor == before && Self::gap(c) {
                        let attempt = c.fill_attempt;
                        c.fill_attempt += 1;
                        let n = self.wait(Purpose::FillBackoff, Some(id), attempt);
                        self.channel(id).wait = Some(n);
                    } else {
                        c.fill_attempt = 0;
                        self.reconcile(id, true);
                    }
                } else {
                    self.subscribe(id);
                    self.reconcile(id, false);
                }
            }
        }
    }
    pub(super) fn send_response(
        &mut self,
        request: Token,
        result: Result<fukulow_api::Message, (Failure, Option<f64>, Option<String>)>,
    ) {
        if !matches!(self.core.requests.get(&request), Some(Request::Send { .. })) {
            return;
        }
        let Some(Request::Send {
            channel: id,
            client_message_id,
            stale,
        }) = self.core.requests.remove(&request)
        else {
            return;
        };
        self.metadata_changed = true;
        if stale {
            if matches!(result, Err((Failure::Status(401), ..))) {
                self.stop(true);
            }
            return;
        }
        if matches!(&result, Err((Failure::Status(409), _, Some(error))) if error == "history_generation_changed")
        {
            self.reset_history(None);
            return;
        }
        self.channel(id);
        match result {
            Ok(message) => {
                if !self.accept_generation(message.history_generation) {
                    return;
                }
                self.merge(id, vec![message], Source::Ack);
                self.reconcile(id, false);
            }
            Err((Failure::Status(401), ..)) => self.stop(true),
            Err((status, delay, error)) => {
                let c = self.channel(id);
                let Some(index) = c
                    .pending
                    .iter()
                    .position(|p| p.client_message_id == client_message_id && p.request == request)
                else {
                    return;
                };
                let mut pending = (*c.pending).clone();
                let p = &mut pending[index];
                if status == Failure::Status(429) {
                    self.cancel(p.retry_wait);
                    let n = self.token();
                    let delay = delay
                        .filter(|d| {
                            d.is_finite()
                                && d.fract() == 0.0
                                && *d >= 1000.0
                                && *d <= 9_007_199_254_740_991.0
                        })
                        .unwrap_or(1000.0) as u64;
                    self.core.timers.insert(
                        n,
                        Timer {
                            purpose: Purpose::SendRetry,
                            channel: Some(id),
                            client_message_id: Some(client_message_id),
                        },
                    );
                    p.state = PendingState::Throttled;
                    p.retry_wait = Some(n);
                    self.out.effects.push(Effect::Wait {
                        id: n,
                        purpose: Purpose::SendRetry,
                        channel: Some(id),
                        delay_ms: Some(delay),
                        attempt: None,
                    });
                } else {
                    p.state =
                        if matches!(status, Failure::Status(400 | 403 | 404 | 409 | 413 | 415)) {
                            PendingState::Failed
                        } else {
                            PendingState::Unknown
                        };
                    p.failure_code = error;
                }
                self.channel(id).pending = Rc::new(pending);
            }
        }
    }
    pub(super) fn timer_elapsed(&mut self, id: Token) {
        let Some(t) = self.core.timers.remove(&id) else {
            return;
        };
        self.metadata_changed = true;
        if t.purpose == Purpose::ReconnectBackoff {
            if self.core.session.reconnect_wait != Some(id) {
                return;
            }
            self.core.session.reconnect_wait = None;
            self.connect();
        } else if let Some(channel) = t.channel {
            let c = self.channel(channel);
            if t.purpose == Purpose::SendRetry {
                if c.state != Availability::Unavailable
                    && let Some(p) = c
                        .pending
                        .iter()
                        .find(|p| {
                            Some(p.client_message_id) == t.client_message_id
                                && p.retry_wait == Some(id)
                                && p.state == PendingState::Throttled
                        })
                        .cloned()
                {
                    self.attempt(channel, p);
                }
            } else {
                if c.wait != Some(id) {
                    return;
                }
                c.wait = None;
                self.reconcile(channel, true);
            }
        }
    }
}
