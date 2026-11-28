//! Observes history generations in the scope and lifetime that issued the request.

use crate::{engine::Step, *};
use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HistoryObservation {
    Success {
        generation: Option<Uuid>,
    },
    Failure {
        status: Failure,
        error: Option<String>,
    },
    Prefetched {
        generation: Option<Uuid>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryObservationResult {
    Accepted,
    Stale,
    Reset,
    Ignored,
}

pub(crate) struct ChannelHistory {
    pub issue: Token,
    pub generation: Option<Uuid>,
}

pub(crate) fn is_generation_conflict(status: Option<u16>, error: Option<&str>) -> bool {
    status == Some(409) && error == Some("history_generation_changed")
}

impl Core {
    /// Capture before issuing a read. A Channel's issue token also identifies its scope.
    pub fn history_issue(&self, channel: Option<Uuid>) -> Option<Token> {
        if !self.session.running {
            return None;
        }
        match channel {
            None => self.organization_history_issue,
            Some(channel) => self
                .channel_history
                .get(&channel)
                .map(|history| history.issue),
        }
    }
}

impl Step<'_> {
    pub(super) fn observe_history_generation(
        &mut self,
        channel: Option<Uuid>,
        issue: Option<Token>,
        lifetime: AccessLifetime,
        result: HistoryObservation,
    ) -> HistoryObservationResult {
        use HistoryObservationResult::*;
        if lifetime != AccessLifetime::Current || !self.core.session.running {
            return Ignored;
        }
        if let HistoryObservation::Prefetched { generation } = result {
            if channel.is_some() {
                return Stale;
            }
            // Startup reads can be reused only if they agree with any generation learned since issue.
            return if self
                .core
                .session
                .history_generation
                .is_some_and(|current| Some(current) != generation)
            {
                Stale
            } else {
                Accepted
            };
        }
        let current_issue = self.core.history_issue(channel);
        if current_issue.is_none() || current_issue != issue {
            return if matches!(result, HistoryObservation::Success { .. }) {
                Stale
            } else {
                Ignored
            };
        }
        match result {
            HistoryObservation::Success {
                generation: Some(generation),
            } => {
                if let Some(channel) = channel {
                    if let Some(history) = self.core.channel_history.get_mut(&channel) {
                        if history
                            .generation
                            .is_none_or(|current| current == generation)
                        {
                            history.generation = Some(generation);
                            return Accepted;
                        }
                        self.restart_channel_history(channel, Some(generation));
                        return Reset;
                    }
                } else if !self.accept_generation(generation) {
                    return Reset;
                }
                Accepted
            }
            HistoryObservation::Failure { status, error }
                if is_generation_conflict(status.http_status(), error.as_deref()) =>
            {
                if let Some(channel) = channel {
                    self.restart_channel_history(channel, None);
                } else {
                    self.reset_history(None);
                }
                Reset
            }
            _ => Ignored,
        }
    }
}
