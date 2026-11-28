//! Classifies normalized REST outcomes in their endpoint and request lifetime.

use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessEndpoint {
    Organization,
    Capabilities,
    History,
    Send,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessLifetime {
    Current,
    StaleRequest,
    RetiredOrganization,
    ReplacedSession,
}

impl AccessLifetime {
    pub(crate) fn request(stale: bool) -> Self {
        if stale {
            Self::StaleRequest
        } else {
            Self::Current
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessOutcome {
    Ignored,
    AccountEnded,
    OrganizationUnavailable,
    ChannelUnavailable,
    LocalRefusal,
    LocalOutcome,
}

pub fn access_outcome(
    endpoint: AccessEndpoint,
    lifetime: AccessLifetime,
    status: Option<u16>,
    error: Option<&str>,
) -> AccessOutcome {
    use AccessEndpoint::*;
    use AccessOutcome::*;

    if lifetime == AccessLifetime::ReplacedSession {
        return Ignored;
    }
    // C6 applies even when the request or its Organization has been retired.
    if status == Some(401) {
        return AccountEnded;
    }
    if lifetime != AccessLifetime::Current {
        return Ignored;
    }
    if error == Some("organization_unavailable") {
        if status == Some(404) {
            return OrganizationUnavailable;
        }
        if matches!(endpoint, Capabilities) && status.is_some() {
            return LocalRefusal;
        }
    }
    match (endpoint, status) {
        (History, Some(403 | 404)) => ChannelUnavailable,
        (Send, Some(status)) if definite_send_refusal(status) => LocalRefusal,
        _ => LocalOutcome,
    }
}

pub(crate) fn definite_send_refusal(status: u16) -> bool {
    matches!(status, 400 | 403 | 404 | 409 | 413 | 415)
}
