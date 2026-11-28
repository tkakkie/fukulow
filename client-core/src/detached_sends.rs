//! Keeps submitted draft restores alive across same-key send attempts and Organization switches.

use crate::{Core, PendingState, Request, Token, access::definite_send_refusal};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Attached,
    Detached,
}

#[derive(Clone, Copy, Debug)]
pub enum SendResult {
    Ack,
    Network,
    Http(f64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Keep,
    Drop,
    Restore,
}

#[derive(Default)]
pub struct DetachedSends {
    submissions: Vec<(Token, State)>,
}

impl DetachedSends {
    pub fn track(&mut self, slot: Token) {
        if let Some(index) = self.index(slot) {
            self.submissions[index].1 = State::Attached;
        } else {
            self.submissions.push((slot, State::Attached));
        }
    }

    pub fn forget(&mut self, slot: Token) {
        if let Some(index) = self.index(slot) {
            self.submissions.remove(index);
        }
    }

    pub fn attached(&self) -> impl Iterator<Item = Token> + '_ {
        self.submissions
            .iter()
            .filter_map(|&(slot, state)| (state == State::Attached).then_some(slot))
    }

    pub fn detach(&mut self, slot: Token) {
        if let Some(index) = self.index(slot) {
            self.submissions[index].1 = State::Detached;
        }
    }

    pub fn reset(&mut self) -> Vec<Token> {
        let mut attached = Vec::new();
        self.submissions.retain(|&(slot, state)| {
            if state == State::Attached {
                attached.push(slot);
                return false;
            }
            true
        });
        attached
    }

    pub fn observe(&mut self, slot: Token, result: SendResult) -> Disposition {
        let Some(index) = self.index(slot) else {
            return Disposition::Keep;
        };
        let (_, state) = self.submissions[index];
        if state == State::Attached
            && matches!(result, SendResult::Network | SendResult::Http(429.0))
        {
            return Disposition::Keep;
        }
        self.submissions.remove(index);
        if state == State::Detached
            && let SendResult::Http(status) = result
            && status == f64::from(status as u16)
            && definite_send_refusal(status as u16)
        {
            Disposition::Restore
        } else {
            Disposition::Drop
        }
    }

    fn index(&self, slot: Token) -> Option<usize> {
        self.submissions.iter().position(|&(key, _)| key == slot)
    }
}

impl Core {
    pub fn can_detach_send(&self, request: Token) -> bool {
        let Some(Request::Send {
            channel,
            client_message_id,
            stale: false,
        }) = self.request(request)
        else {
            return false;
        };
        self.channel(*channel).is_some_and(|channel| {
            channel.pending.iter().any(|pending| {
                pending.client_message_id == *client_message_id
                    && pending.request == request
                    && pending.state != PendingState::Unknown
            })
        })
    }
}

pub fn can_restore_draft(
    revision: f64,
    current_revision: f64,
    store_revision: Option<f64>,
    current_store_revision: Option<f64>,
    empty: bool,
) -> bool {
    revision == current_revision && store_revision == current_store_revision && empty
}
