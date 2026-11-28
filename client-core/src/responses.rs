use crate::{engine::Step, merge::Source, *};
use fukulow_api::MessagePage;

pub(crate) enum HistoryPage {
    Messages(MessagePage),
    Events(fukulow_api::ChannelEventPage),
}

impl Step<'_> {
    pub(super) fn history_response(
        &mut self,
        request: Token,
        result: Result<HistoryPage, (Failure, Option<&str>)>,
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
        let access = match &result {
            Err((status, error)) => access_outcome(
                AccessEndpoint::History,
                AccessLifetime::request(stale),
                status.http_status(),
                *error,
            ),
            Ok(_) if stale => AccessOutcome::Ignored,
            Ok(_) => AccessOutcome::LocalOutcome,
        };
        match access {
            AccessOutcome::AccountEnded if stale => return self.stop(true),
            AccessOutcome::OrganizationUnavailable => return self.organization_unavailable(),
            AccessOutcome::Ignored => return,
            _ => {}
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
            Err(_) if access == AccessOutcome::AccountEnded => self.stop(true),
            Err(_) if access == AccessOutcome::ChannelUnavailable => self.unavailable(id),
            Err(_) => {
                if page == Page::After {
                    if Self::gap(c) {
                        self.fill_backoff_or_reconcile(id, true);
                    }
                } else if page == Page::Latest {
                    c.history_error = true;
                }
            }
            Ok(HistoryPage::Events(result)) => {
                if page != Page::After {
                    return;
                }
                // Event pages hydrate current state. Re-read from the cursor if
                // this request could have predated an evicted Move floor.
                if mutation_seq < c.retired_move_through {
                    self.reconcile(id, true);
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
                let back_off = c.cursor == before && Self::gap(c);
                self.fill_backoff_or_reconcile(id, back_off);
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
                            .map(|through| through.min(first.saturating_sub(1)))
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
                    let back_off = c.cursor == before && Self::gap(c);
                    self.fill_backoff_or_reconcile(id, back_off);
                } else {
                    self.subscribe(id);
                    self.reconcile(id, false);
                }
            }
        }
    }

    fn fill_backoff_or_reconcile(&mut self, id: Uuid, back_off: bool) {
        let c = self.channel(id);
        if back_off {
            let attempt = c.fill_attempt;
            c.fill_attempt += 1;
            let n = self.wait(Purpose::FillBackoff, Some(id), attempt);
            self.channel(id).wait = Some(n);
        } else {
            c.fill_attempt = 0;
            self.reconcile(id, true);
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
            if t.purpose == Purpose::SendRetry {
                self.send_retry_elapsed(channel, id, t.client_message_id);
            } else {
                let c = self.channel(channel);
                if c.wait != Some(id) {
                    return;
                }
                c.wait = None;
                self.reconcile(channel, true);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fill_backoff_uses_the_current_nonzero_attempt_for_its_wait() {
        let channel = Uuid::from_u128(1);
        let mut core = Core::new(Uuid::from_u128(2));
        let mut step = Step::new(&mut core);
        let c = step.channel(channel);
        c.cursor = Some(1);
        c.held_through = Some(3);
        c.fill_attempt = 2;

        step.fill_backoff_or_reconcile(channel, true);

        let c = step.channel(channel);
        assert_eq!(c.fill_attempt, 3);
        let wait = c.wait.unwrap();
        assert!(matches!(
            step.out.effects.as_slice(),
            [Effect::Wait {
                id,
                purpose: Purpose::FillBackoff,
                channel: Some(wait_channel),
                delay_ms: None,
                attempt: Some(2),
            }] if *id == wait && *wait_channel == channel
        ));
    }

    #[test]
    fn latest_page_clears_retired_floor_at_minimum_creation_position() {
        let channel = Uuid::from_u128(1);
        let mut core = Core::new(Uuid::from_u128(2));
        let mut step = Step::new(&mut core);
        step.channel(channel).retired_through = Some(10);
        step.history(channel, Page::Latest, None);
        let request = step.channel(channel).latest.unwrap();
        let page = serde_json::from_value(json!({
            "history_generation": Uuid::nil(), "as_of_seq": 10, "has_more": true,
            "messages": [{
                "history_generation": Uuid::nil(), "channel_id": channel,
                "id": Uuid::from_u128(3), "client_message_id": Uuid::from_u128(4),
                "created_seq": i64::MIN, "version": i64::MIN, "deleted": false,
                "sender": Uuid::from_u128(5), "body": "message",
                "created_at": "2026-01-01T00:00:00Z", "topic_id": null,
                "reply_to": null, "reply_root_id": null, "mentions": []
            }]
        }))
        .unwrap();

        step.history_response(request, Ok(HistoryPage::Messages(page)));

        assert_eq!(step.channel(channel).retired_through, None);
    }
}
