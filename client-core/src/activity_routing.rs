//! Routes Organization activity notices and owns the O5 timer generation.
use crate::{AccessLifetime, Token};
use serde::{Deserialize, Serialize};

#[cfg(test)]
mod tests;

const DEBOUNCE_MS: u16 = 200;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityChannelKind {
    Channel,
    Dm,
    // An unrecognised kind still counts as a present value.
    #[serde(other)]
    Other,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ActivityFacts {
    pub kind: Option<ActivityChannelKind>,
    pub has_kind_lookup: bool,
    pub watched: bool,
    pub list_covered: bool,
    pub projection_covered: bool,
    pub after_lists: bool,
    pub as_of_seq: Option<i64>,
    pub main_read_seq: Option<i64>,
    pub topic_read_seq: Option<i64>,
}

/// Only routing facts from a classified notice. Identities stay with the effect owner.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityNotice {
    ActivityReady,
    ActivityReset,
    SectionsChanged,
    ChannelActivity(i64),
    ReadPositionChanged {
        read_seq: i64,
        topic: bool,
    },
    ChannelAccessRevoked,
    ChannelAccessGained,
    DmListChanged,
    ChannelListChanged,
    ChannelMembersChanged,
    MembersChanged,
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityInput {
    Notice {
        event: ActivityNotice,
        connection: Option<Token>,
        current_connection: Option<Token>,
        facts: Option<ActivityFacts>,
    },
    Tick {
        generation: Token,
        connection: Option<Token>,
        current_connection: Option<Token>,
    },
    Disconnected,
    Close,
    InvalidateMemberLists,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityDelay {
    First,
    Periodic,
    Reset,
}

pub fn activity_delay(timing: ActivityDelay, period: Option<f64>, draw: f64) -> f64 {
    let period = period.unwrap_or(30_000.0);
    match timing {
        ActivityDelay::First => draw * period,
        ActivityDelay::Periodic => period + (draw * 2.0 - 1.0) * period / 10.0,
        ActivityDelay::Reset => draw * 2000.0,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityTarget {
    Channels,
    ArchivedChannels,
    OpenChannel,
    Dms,
    Sections,
    Capabilities,
    ChannelMembers,
    Main,
    Topic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityReason {
    Notice,
    Access,
    Reconcile,
    Periodic,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActivityEffect {
    Inspect,
    ReadyTargets,
    ObserveRead,
    InspectReadProjection,
    NotifySections,
    Revoke,
    RetireChannelMembers,
    Gain,
    Invalidate {
        target: ActivityTarget,
        reason: ActivityReason,
        debounce: u16,
        discovery: Option<bool>,
    },
    InvalidateMemberLists {
        key: &'static str,
        prefix: &'static str,
        reason: ActivityReason,
        debounce: u16,
    },
    Reconcile {
        reason: ActivityReason,
        first: ActivityTarget,
        ready: bool,
        debounce: u16,
        jitter: Option<ActivityDelay>,
    },
    Arm {
        generation: Token,
        timing: ActivityDelay,
    },
    Cancel,
    DisconnectTargets,
    CloseTargets,
}

#[derive(Default)]
pub struct ActivityRouting {
    generation: Token,
    scheduled: Option<Token>,
    closed: bool,
}

impl ActivityRouting {
    pub fn step(&mut self, input: ActivityInput, lifetime: AccessLifetime) -> Vec<ActivityEffect> {
        use ActivityEffect::*;
        match input {
            ActivityInput::Close => {
                self.closed = true;
                self.scheduled = None;
                vec![Cancel, CloseTargets]
            }
            ActivityInput::Disconnected => {
                self.scheduled = None;
                vec![Cancel, DisconnectTargets]
            }
            _ if self.closed || lifetime != AccessLifetime::Current => Vec::new(),
            ActivityInput::Tick {
                generation,
                connection,
                current_connection,
            } if self.scheduled == Some(generation)
                && current_epoch(connection, current_connection) =>
            {
                vec![
                    reconcile(ActivityReason::Periodic, false, None),
                    Arm {
                        generation,
                        timing: ActivityDelay::Periodic,
                    },
                ]
            }
            ActivityInput::Notice {
                event,
                connection,
                current_connection,
                facts,
            } if current_epoch(connection, current_connection) => self.notice(event, facts),
            ActivityInput::InvalidateMemberLists => vec![member_lists()],
            _ => Vec::new(),
        }
    }

    fn notice(
        &mut self,
        event: ActivityNotice,
        facts: Option<ActivityFacts>,
    ) -> Vec<ActivityEffect> {
        use ActivityEffect::*;
        use ActivityReason::{Access, Notice};
        use ActivityTarget::*;
        let mut effects = Vec::new();
        match event {
            ActivityNotice::ActivityReady => {
                if facts.is_none() {
                    return vec![ReadyTargets];
                }
                self.generation += 1;
                self.scheduled = Some(self.generation);
                effects.extend([
                    Cancel,
                    Arm {
                        generation: self.generation,
                        timing: ActivityDelay::First,
                    },
                    reconcile(ActivityReason::Reconcile, true, None),
                ]);
            }
            ActivityNotice::ActivityReset => effects.push(reconcile(
                ActivityReason::Reconcile,
                false,
                Some(ActivityDelay::Reset),
            )),
            ActivityNotice::SectionsChanged => effects.push(NotifySections),
            ActivityNotice::ChannelActivity(seq) => {
                let Some(facts) = facts else {
                    return vec![Inspect];
                };
                if unknown_kind(&facts)
                    || (!facts.watched && !facts.list_covered && !covers(facts.as_of_seq, seq))
                {
                    lists(&mut effects, facts.kind, Notice);
                }
            }
            ActivityNotice::ReadPositionChanged { read_seq, topic } => {
                let Some(facts) = facts else {
                    return vec![ObserveRead];
                };
                if facts.after_lists {
                    let topic_covered = topic && covers(facts.topic_read_seq, read_seq);
                    if facts.watched && !facts.projection_covered && !topic_covered {
                        let target = if topic { Topic } else { Main };
                        effects.push(invalidate(target, Notice, None));
                    }
                } else {
                    let main_covered = !topic && covers(facts.main_read_seq, read_seq);
                    if unknown_kind(&facts) || (!facts.list_covered && !main_covered) {
                        lists(&mut effects, facts.kind, Notice);
                    }
                    effects.push(InspectReadProjection);
                }
            }
            ActivityNotice::ChannelAccessRevoked | ActivityNotice::ChannelAccessGained => {
                let Some(facts) = facts else {
                    return vec![Inspect];
                };
                if matches!(event, ActivityNotice::ChannelAccessRevoked) {
                    effects.extend([Revoke, RetireChannelMembers]);
                } else {
                    effects.push(Gain);
                }
                lists(&mut effects, facts.kind, Access);
                if facts.kind != Some(ActivityChannelKind::Dm) {
                    effects.push(invalidate(OpenChannel, Access, None));
                }
                effects.push(member_lists());
            }
            ActivityNotice::DmListChanged => effects.push(invalidate(Dms, Access, Some(true))),
            ActivityNotice::ChannelListChanged => {
                channel_lists(&mut effects, Access);
                effects.push(invalidate(OpenChannel, Access, None));
            }
            ActivityNotice::ChannelMembersChanged => {
                effects.push(invalidate(ChannelMembers, Access, None));
            }
            ActivityNotice::MembersChanged => {
                effects.extend([invalidate(Capabilities, Access, None), member_lists()]);
            }
            ActivityNotice::Other => {}
        }
        effects
    }
}

fn current_epoch(connection: Option<Token>, current_connection: Option<Token>) -> bool {
    connection.is_none() || connection == current_connection
}

fn unknown_kind(facts: &ActivityFacts) -> bool {
    facts.has_kind_lookup && facts.kind.is_none()
}

fn covers(accepted: Option<i64>, required: i64) -> bool {
    accepted.is_some_and(|position| position >= required)
}

fn invalidate(
    target: ActivityTarget,
    reason: ActivityReason,
    discovery: Option<bool>,
) -> ActivityEffect {
    ActivityEffect::Invalidate {
        target,
        reason,
        debounce: DEBOUNCE_MS,
        discovery,
    }
}

fn channel_lists(effects: &mut Vec<ActivityEffect>, reason: ActivityReason) {
    use ActivityTarget::*;
    if reason == ActivityReason::Access {
        effects.push(invalidate(Sections, reason, None));
    }
    effects.extend([
        invalidate(Channels, reason, None),
        invalidate(ArchivedChannels, reason, None),
    ]);
}

fn lists(
    effects: &mut Vec<ActivityEffect>,
    kind: Option<ActivityChannelKind>,
    reason: ActivityReason,
) {
    if kind != Some(ActivityChannelKind::Dm) {
        channel_lists(effects, reason);
    }
    // Only access changes and unknown kinds can discover a DM under P-D5.
    if kind != Some(ActivityChannelKind::Channel) {
        effects.push(invalidate(
            ActivityTarget::Dms,
            reason,
            Some(reason == ActivityReason::Access || kind.is_none()),
        ));
    }
}

fn member_lists() -> ActivityEffect {
    ActivityEffect::InvalidateMemberLists {
        key: "members",
        prefix: "channel-members:",
        reason: ActivityReason::Access,
        debounce: DEBOUNCE_MS,
    }
}

fn reconcile(reason: ActivityReason, ready: bool, jitter: Option<ActivityDelay>) -> ActivityEffect {
    ActivityEffect::Reconcile {
        reason,
        // Member lists consult the identity authority when invalidated.
        first: ActivityTarget::Capabilities,
        ready,
        debounce: DEBOUNCE_MS,
        jitter,
    }
}
