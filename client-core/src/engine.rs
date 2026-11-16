use crate::*;
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
    pub fn stop(&mut self, sign_in: bool) {
        let timers: Vec<_> = self.core.timers.keys().copied().collect();
        for id in timers {
            self.cancel(Some(id));
        }
        self.core.session.running = false;
        self.core.session.connected = false;
        self.core.session.connection = None;
        self.core.requests.clear();
        self.metadata_changed = true;
        self.clear_channels();
        self.out.effects.push(Effect::Close);
        if sign_in {
            self.core.session.session = Session::SignInRequired;
            self.out.effects.push(Effect::SignIn);
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
                channel: id,
                page,
                seq,
                stale: false,
            },
        );
        self.metadata_changed = true;
        self.out.effects.push(Effect::FetchHistory {
            id: n,
            channel: id,
            page,
            seq,
        });
    }
    pub fn gap(c: &ChannelView) -> bool {
        c.cursor.is_some_and(|cursor| {
            c.held_through.unwrap_or(0) > cursor + 1
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
    pub fn attempt(&mut self, id: Uuid, mut p: Pending) {
        self.cancel(p.retry_wait);
        let n = self.token();
        p.state = PendingState::Sending;
        p.request = n;
        p.retry_wait = None;
        let c = self.channel(id);
        let mut pending = (*c.pending).clone();
        if let Some(index) = pending
            .iter()
            .position(|v| v.client_message_id == p.client_message_id)
        {
            pending[index] = p.clone();
        } else {
            pending.push(p.clone());
        }
        c.pending = Rc::new(pending);
        self.core.requests.insert(
            n,
            Request::Send {
                channel: id,
                client_message_id: p.client_message_id,
                stale: false,
            },
        );
        self.metadata_changed = true;
        self.out.effects.push(Effect::Send {
            id: n,
            channel: id,
            client_message_id: p.client_message_id,
            body: p.body,
            reply_to: p.reply_to,
            topic_name: p.topic_name,
        });
    }
    pub fn unavailable(&mut self, id: Uuid) {
        self.invalidate(id, false);
        let c = self.channel(id).clone();
        if c.subscription.is_some() && self.core.session.connected {
            self.out.effects.push(Effect::Unsubscribe { channel: id });
        }
        let mut pending = (*c.pending).clone();
        for p in &mut pending {
            self.cancel(p.retry_wait);
            p.state = PendingState::Failed;
            p.retry_wait = None;
        }
        let c = self.channel(id);
        c.subscription = None;
        c.state = Availability::Unavailable;
        c.pending = Rc::new(pending);
        for r in self.core.requests.values_mut() {
            if r.channel() == id && matches!(r, Request::Send { .. }) {
                r.invalidate();
                self.metadata_changed = true;
            }
        }
    }
    fn trim(&mut self, id: Uuid, limit: usize) {
        let c = self.channel(id);
        c.messages = Rc::new(c.messages[c.messages.len().saturating_sub(limit)..].to_vec());
        c.retained_count = Some(c.messages.len());
        c.has_older = true;
    }
    fn retention(&mut self) {
        for (id, before) in &self.touched {
            let changed = before
                .as_ref()
                .zip(self.core.channel(*id))
                .is_none_or(|(a, b)| !Rc::ptr_eq(&a.messages, &b.messages));
            if changed && let Some(c) = self.core.channels.get_mut(id) {
                c.retained_count = Some(c.messages.len());
            }
        }
        let mut inactive: Vec<_> = self
            .core
            .channel_order
            .iter()
            .filter_map(|id| {
                self.core
                    .channel(*id)
                    .filter(|c| !c.watched)
                    .map(|c| (*id, c.last_used.unwrap_or(0)))
            })
            .collect();
        inactive.sort_by_key(|a| std::cmp::Reverse(a.1));
        for (index, (id, _)) in inactive.into_iter().enumerate() {
            let limit = if index < INACTIVE_CHANNEL_LIMIT {
                INACTIVE_CHANNEL_MESSAGE_LIMIT
            } else {
                0
            };
            if self
                .core
                .channel(id)
                .is_some_and(|c| c.retained_count.unwrap_or(0) > limit)
            {
                self.trim(id, limit);
            }
        }
        let mut priority: Vec<_> = self
            .core
            .channel_order
            .iter()
            .filter_map(|id| {
                self.core
                    .channel(*id)
                    .map(|c| (*id, c.watched, c.last_used.unwrap_or(0)))
            })
            .collect();
        priority.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
        let mut remaining = SYNC_MESSAGE_LIMIT;
        for (id, _, _) in priority {
            if self
                .core
                .channel(id)
                .is_some_and(|c| c.retained_count.unwrap_or(0) > remaining)
            {
                self.trim(id, remaining);
            }
            remaining -= self
                .core
                .channel(id)
                .and_then(|c| c.retained_count)
                .unwrap_or(0);
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
