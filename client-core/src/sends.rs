//! Owns the pending-send lifecycle.

use crate::{engine::Step, merge::Source, *};
use fukulow_api::Message;
use std::rc::Rc;

#[cfg(test)]
mod tests;

impl Step<'_> {
    pub(super) fn user_send(
        &mut self,
        id: Uuid,
        client_message_id: Uuid,
        body: String,
        reply_to: Option<Uuid>,
        topic_name: Option<String>,
        reply_root_id: Option<Uuid>,
    ) {
        // ECMAScript trim includes BOM and excludes Unicode NEL.
        if body
            .trim_matches(|ch: char| ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}'))
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
    pub(super) fn user_retry(&mut self, id: Uuid, client_message_id: Uuid) {
        let c = self.channel(id);
        if c.state != Availability::Unavailable
            && let Some(p) = c
                .pending
                .iter()
                .find(|p| {
                    p.client_message_id == client_message_id && p.state == PendingState::Unknown
                })
                .cloned()
        {
            self.attempt(id, p);
        }
    }
    pub(super) fn user_discard(&mut self, channel: Uuid, client_message_id: Uuid) {
        if let Some(c) = self.core.channel(channel) {
            let pending = c.pending.clone();
            self.remove_pending_sends(channel, &pending, |p| {
                p.client_message_id == client_message_id && p.state != PendingState::Sending
            });
        }
    }
    fn attempt(&mut self, id: Uuid, mut p: Pending) {
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
            history_generation: self.core.session.history_generation,
            id: n,
            channel: id,
            client_message_id: p.client_message_id,
            body: p.body,
            reply_to: p.reply_to,
            topic_name: p.topic_name,
        });
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
        let access = match &result {
            Err((status, _, error)) => access_outcome(
                AccessEndpoint::Send,
                AccessLifetime::request(stale),
                status.http_status(),
                error.as_deref(),
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
            Err(_) if access == AccessOutcome::AccountEnded => self.stop(true),
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
                    p.state = if access == AccessOutcome::LocalRefusal {
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
    pub(super) fn send_retry_elapsed(
        &mut self,
        channel: Uuid,
        id: Token,
        client_message_id: Option<Uuid>,
    ) {
        let c = self.channel(channel);
        if c.state != Availability::Unavailable
            && let Some(p) = c
                .pending
                .iter()
                .find(|p| {
                    Some(p.client_message_id) == client_message_id
                        && p.retry_wait == Some(id)
                        && p.state == PendingState::Throttled
                })
                .cloned()
        {
            self.attempt(channel, p);
        }
    }
    pub(super) fn settle(&mut self, id: Uuid, records: &[Message]) {
        let self_id = self.core.session.self_id;
        let settled: Vec<_> = records
            .iter()
            .filter(|m| m.channel_id == id && m.sender == self_id)
            .map(|m| m.client_message_id)
            .collect();
        let pending = self.channel(id).pending.clone();
        self.remove_pending_sends(id, &pending, |p| settled.contains(&p.client_message_id));
    }
    fn remove_pending_sends(
        &mut self,
        id: Uuid,
        pending: &[Pending],
        matches: impl Fn(&Pending) -> bool,
    ) {
        if pending.iter().any(&matches) {
            for p in pending.iter().filter(|p| matches(p)) {
                self.cancel(p.retry_wait);
            }
            self.channel(id).pending =
                Rc::new(pending.iter().filter(|p| !matches(p)).cloned().collect());
        }
    }
    pub(super) fn interrupt_pending_sends(&mut self, pending: &[Pending]) -> Rc<Vec<Pending>> {
        let mut pending = pending.to_vec();
        for p in &mut pending {
            self.cancel(p.retry_wait);
            p.retry_wait = None;
            if matches!(p.state, PendingState::Sending | PendingState::Throttled) {
                p.state = PendingState::Unknown;
            }
        }
        Rc::new(pending)
    }
    pub(super) fn fail_pending_sends(&mut self, pending: &[Pending]) -> Rc<Vec<Pending>> {
        let mut pending = pending.to_vec();
        for p in &mut pending {
            self.cancel(p.retry_wait);
            p.state = PendingState::Failed;
            p.retry_wait = None;
        }
        Rc::new(pending)
    }
}
