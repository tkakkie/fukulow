use crate::{history_generation::ChannelHistory, *};
use std::rc::Rc;

pub(crate) struct Step<'a> {
    pub core: &'a mut Core,
    before: SessionView,
    pub touched: Vec<(Uuid, Option<ChannelView>)>,
    pub out: StepResult,
    pub metadata_changed: bool,
    pub force_changed: bool,
    pub direct: bool,
    pub refresh_mentions: bool,
}
impl<'a> Step<'a> {
    pub fn new(core: &'a mut Core) -> Self {
        Self {
            before: core.session.clone(),
            core,
            touched: vec![],
            out: StepResult::default(),
            metadata_changed: false,
            force_changed: false,
            direct: false,
            refresh_mentions: false,
        }
    }
    pub fn token(&mut self) -> Token {
        let n = self.core.session.next;
        self.core.session.next += 1;
        n
    }
    pub fn channel(&mut self, id: Uuid) -> &mut ChannelView {
        if !self.touched.iter().any(|(key, _)| *key == id) {
            self.touched.push((id, self.core.channel(id).cloned()));
        }
        if !self.core.channels.contains_key(&id) {
            self.core.channel_order.push(id);
        }
        self.core.channels.entry(id).or_default()
    }
    pub fn ids(&self) -> Vec<Uuid> {
        self.core.channel_order.clone()
    }
    pub fn clear_channels(&mut self) {
        for id in self.ids() {
            self.channel(id);
        }
        self.core.channels.clear();
        self.core.channel_order.clear();
        self.core.channel_history.clear();
    }
    pub fn cancel(&mut self, id: Option<Token>) {
        if let Some(id) = id
            && self.core.timers.remove(&id).is_some()
        {
            self.metadata_changed = true;
            self.out.effects.push(Effect::CancelTimer { id });
        }
    }
    pub fn wait(&mut self, purpose: Purpose, channel: Option<Uuid>, attempt: u64) -> Token {
        let id = self.token();
        self.core.timers.insert(
            id,
            Timer {
                purpose,
                channel,
                client_message_id: None,
            },
        );
        self.metadata_changed = true;
        self.out.effects.push(Effect::Wait {
            id,
            purpose,
            channel,
            attempt: Some(attempt),
            delay_ms: None,
        });
        id
    }
    pub fn connect(&mut self) {
        let id = self.token();
        self.core.socket_replies.clear();
        self.core.membership_probe_pending = false;
        self.core.session.connection = Some(id);
        self.out.effects.push(Effect::Connect { id });
    }
    pub fn invalidate(&mut self, id: Uuid, sends: bool) {
        let wait = self.channel(id).wait;
        self.cancel(wait);
        let c = self.channel(id);
        c.wait = None;
        c.fill = None;
        c.latest = None;
        c.older = None;
        for r in self.core.requests.values_mut() {
            if !r.stale() && r.channel() == id && (sends || matches!(r, Request::History { .. })) {
                r.invalidate();
                self.metadata_changed = true;
            }
        }
    }
    pub(super) fn teardown(&mut self) {
        let timers: Vec<_> = self.core.timers.keys().copied().collect();
        for id in timers {
            self.cancel(Some(id));
        }
        self.core.session.running = false;
        self.core.session.connected = false;
        self.core.session.connection = None;
        self.core.socket_replies.clear();
        self.core.membership_probe_pending = false;
        self.core.requests.clear();
        self.metadata_changed = true;
        self.out.effects.push(Effect::Close);
    }
    pub fn stop(&mut self, sign_in: bool) {
        self.teardown();
        self.clear_channels();
        if sign_in {
            self.core.session.session = Session::SignInRequired;
            self.out.effects.push(Effect::SignIn);
        }
    }
    pub fn expire_window(&mut self, id: Uuid, retry: bool) {
        for request in self.core.requests.values_mut() {
            if matches!(request, Request::History { channel, page: Page::Latest | Page::Before, .. } if *channel == id)
            {
                request.invalidate();
            }
        }
        let c = self.channel(id);
        c.messages = Rc::default();
        c.has_older = false;
        c.snapshot_seq = None;
        c.latest = None;
        c.older = None;
        c.history_error = !retry;
        if retry {
            self.history(id, Page::Latest, None);
        }
    }
    pub fn accept_generation(&mut self, generation: Uuid) -> bool {
        if self
            .core
            .session
            .history_generation
            .is_some_and(|old| old != generation)
        {
            self.reset_history(Some(generation));
            return false;
        }
        self.core.session.history_generation = Some(generation);
        true
    }
    pub fn reset_history(&mut self, generation: Option<Uuid>) {
        let reconnect = self.core.session.reconnect_wait.take();
        self.cancel(reconnect);
        self.core.session.history_generation = generation;
        self.core.session.history_epoch += 1;
        for id in self.ids() {
            self.clear_channel_history(id);
        }
        // A fresh socket fences frames from retired subscriptions without discarding HTTP
        // completions: their same-session late 401 still has authority.
        self.core.session.connected = false;
        self.connect();
        self.core.organization_history_issue = self.core.session.connection;
        for id in self.ids() {
            let c = self.channel(id);
            if c.watched && c.state != Availability::Unavailable {
                self.history(id, Page::Latest, None);
            }
        }
    }
    fn clear_channel_history(&mut self, id: Uuid) {
        self.core.channel_history.remove(&id);
        let old = self.channel(id).clone();
        if old.subscription.is_some() && self.core.session.connected {
            self.out.effects.push(Effect::Unsubscribe { channel: id });
        }
        self.invalidate(id, true);
        let pending = self.interrupt_pending_sends(&old.pending);
        *self.channel(id) = ChannelView {
            watched: old.watched,
            pending,
            state: if old.state == Availability::Unavailable {
                Availability::Unavailable
            } else {
                Availability::Loading
            },
            ..ChannelView::default()
        };
    }
    pub(super) fn restart_channel_history(&mut self, id: Uuid, generation: Option<Uuid>) {
        self.clear_channel_history(id);
        self.history(id, Page::Latest, None);
        if let Some(history) = self.core.channel_history.get_mut(&id) {
            history.generation = generation;
        }
    }
    pub fn subscribe(&mut self, id: Uuid) {
        let connected = self.core.session.connected;
        let c = self.channel(id);
        if !connected
            || !c.watched
            || c.state == Availability::Unavailable
            || c.cursor.is_none()
            || c.subscription.is_some()
        {
            return;
        }
        let after = c.cursor.unwrap_or_default();
        let n = self.token();
        let c = self.channel(id);
        c.state = Availability::Loading;
        c.subscription = Some(Rc::new(Subscription {
            id: n,
            after,
            confirmed: false,
            watermark: after,
        }));
        self.out.effects.push(Effect::Subscribe {
            history_generation: self.core.session.history_generation,
            id: n,
            channel: id,
            after_seq: after,
        });
    }
    pub fn history(&mut self, id: Uuid, page: Page, seq: Option<i64>) {
        let c = self.channel(id);
        let existing = match page {
            Page::Latest => c.latest,
            Page::Before => c.older,
            Page::After => c.fill,
        };
        if existing.is_some() {
            return;
        }
        let n = self.token();
        if self.channel(id).watched {
            self.core
                .channel_history
                .entry(id)
                .or_insert(ChannelHistory {
                    issue: n,
                    generation: None,
                });
        }
        let c = self.channel(id);
        match page {
            Page::Latest => c.latest = Some(n),
            Page::Before => c.older = Some(n),
            Page::After => c.fill = Some(n),
        }
        c.history_error = false;
        self.core.requests.insert(
            n,
            Request::History {
                mutation_seq: self.core.channel(id).map_or(0, |c| c.mutation_seq),
                channel: id,
                page,
                seq,
                stale: false,
            },
        );
        self.metadata_changed = true;
        self.out.effects.push(Effect::FetchHistory {
            history_generation: self.core.session.history_generation,
            as_of_seq: if page == Page::Before {
                self.core.channel(id).and_then(|c| c.snapshot_seq)
            } else {
                None
            },
            id: n,
            channel: id,
            page,
            seq,
        });
    }
    pub fn gap(c: &ChannelView) -> bool {
        c.cursor.is_some_and(|cursor| {
            c.held_through.unwrap_or(0) > cursor.saturating_add(1)
                || c.forgotten_through.unwrap_or(0) > cursor
                || c.subscription
                    .as_ref()
                    .is_some_and(|s| s.confirmed && s.watermark > cursor)
        })
    }
    pub fn reconcile(&mut self, id: Uuid, immediate: bool) {
        let connected = self.core.session.connected;
        let c = self.channel(id).clone();
        if !c.watched
            || c.state == Availability::Unavailable
            || c.cursor.is_none()
            || !connected
            || !c.subscription.as_ref().is_some_and(|s| s.confirmed)
        {
            return;
        }
        if !Self::gap(&c) {
            self.cancel(c.wait);
            self.channel(id).wait = None;
            return;
        }
        if c.fill.is_some()
            || c.wait
                .and_then(|n| self.core.timers.get(&n))
                .is_some_and(|t| t.purpose == Purpose::FillBackoff)
        {
            return;
        }
        let covered = c
            .subscription
            .as_ref()
            .is_some_and(|s| s.confirmed && Some(s.watermark) > c.cursor);
        if immediate || covered {
            self.cancel(c.wait);
            self.channel(id).wait = None;
            self.history(id, Page::After, c.cursor);
        } else if c.wait.is_none() {
            let n = self.wait(Purpose::ReorderGrace, Some(id), 0);
            self.channel(id).wait = Some(n);
        }
    }
    pub fn unavailable(&mut self, id: Uuid) {
        self.invalidate(id, false);
        let c = self.channel(id).clone();
        if c.subscription.is_some() && self.core.session.connected {
            self.out.effects.push(Effect::Unsubscribe { channel: id });
        }
        let pending = self.fail_pending_sends(&c.pending);
        let c = self.channel(id);
        c.subscription = None;
        c.state = Availability::Unavailable;
        c.pending = pending;
        self.core.channel_history.remove(&id);
        for r in self.core.requests.values_mut() {
            if r.channel() == id && matches!(r, Request::Send { .. }) {
                r.invalidate();
                self.metadata_changed = true;
            }
        }
    }
    pub fn finish(mut self) -> StepResult {
        if !self.direct {
            self.retention();
        }
        for (id, before) in &self.touched {
            let after = self.core.channel(*id);
            if self.direct
                || match (before, after) {
                    (Some(a), Some(b)) => !a.same(b),
                    (None, None) => false,
                    _ => true,
                }
            {
                self.out.changed_channels.push(*id);
            }
        }
        self.out.state_changed = self.force_changed
            || self.metadata_changed
            || !self.out.changed_channels.is_empty()
            || self.before != self.core.session;
        self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gap_is_false_at_maximum_cursor() {
        let channel = ChannelView {
            cursor: Some(i64::MAX),
            held_through: Some(i64::MAX),
            forgotten_through: Some(i64::MAX),
            ..ChannelView::default()
        };
        assert!(!Step::gap(&channel));
    }
}
