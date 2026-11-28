//! Observes the Organization's history generation across request lifetimes.

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

pub(crate) fn is_generation_conflict(status: Option<u16>, error: Option<&str>) -> bool {
    status == Some(409) && error == Some("history_generation_changed")
}

impl Core {
    /// Capture the Organization's token before issuing a read.
    pub fn history_issue(&self) -> Option<Token> {
        self.organization_history_issue
            .filter(|_| self.session.running)
    }
}

impl Step<'_> {
    pub(super) fn observe_history_generation(
        &mut self,
        issue: Option<Token>,
        lifetime: AccessLifetime,
        result: HistoryObservation,
    ) -> HistoryObservationResult {
        use HistoryObservationResult::*;
        if lifetime != AccessLifetime::Current || !self.core.session.running {
            return Ignored;
        }
        if let HistoryObservation::Prefetched { generation } = result {
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
        // Ordinary requests issued before SessionStart have no token for the running Session.
        let current_issue = self.core.history_issue();
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
                if self.accept_generation(generation) {
                    Accepted
                } else {
                    Reset
                }
            }
            HistoryObservation::Failure { status, error }
                if is_generation_conflict(status.http_status(), error.as_deref()) =>
            {
                self.reset_history(None);
                Reset
            }
            _ => Ignored,
        }
    }
}
