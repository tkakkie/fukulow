use super::*;
use ActivityChannelKind::{Channel, Dm};
use ActivityEffect::*;
use ActivityReason::{Access, Notice, Periodic};
use ActivityTarget::*;

fn notice(event: ActivityNotice, facts: ActivityFacts) -> ActivityInput {
    ActivityInput::Notice {
        event,
        connection: Some(7),
        current_connection: Some(7),
        facts: Some(facts),
    }
}

fn route(input: ActivityInput) -> Vec<ActivityEffect> {
    let projection = match &input {
        ActivityInput::Notice {
            event: event @ ActivityNotice::ReadPositionChanged { .. },
            connection,
            current_connection,
            facts: Some(facts),
        } => Some(ActivityInput::Notice {
            event: *event,
            connection: *connection,
            current_connection: *current_connection,
            facts: Some(ActivityFacts {
                after_lists: true,
                ..*facts
            }),
        }),
        _ => None,
    };
    let mut router = ActivityRouting::default();
    let mut effects = router.step(input, AccessLifetime::Current);
    if effects.last() == Some(&InspectReadProjection) {
        effects.pop();
        effects.extend(router.step(projection.unwrap(), AccessLifetime::Current));
    }
    effects
}

fn channel_activity() -> ActivityNotice {
    ActivityNotice::ChannelActivity(10)
}

fn read(topic: bool) -> ActivityNotice {
    ActivityNotice::ReadPositionChanged {
        topic,
        read_seq: 10,
    }
}

fn ready(router: &mut ActivityRouting) -> Token {
    let effects = router.step(
        notice(ActivityNotice::ActivityReady, ActivityFacts::default()),
        AccessLifetime::Current,
    );
    let [
        Cancel,
        Arm {
            generation,
            timing: ActivityDelay::First,
        },
        Reconcile {
            reason: ActivityReason::Reconcile,
            first: Capabilities,
            ready: true,
            debounce: 200,
            jitter: None,
        },
    ] = effects.as_slice()
    else {
        panic!("expected Ready to replace the timer and reconcile, got {effects:?}");
    };
    *generation
}

fn tick(generation: Token) -> ActivityInput {
    ActivityInput::Tick {
        generation,
        connection: Some(7),
        current_connection: Some(7),
    }
}

#[test]
fn unrecognised_notice_type_has_no_effects() {
    let input = serde_json::from_str(
        r#"{"notice":{"event":"future_notice","connection":7,"current_connection":7}}"#,
    )
    .unwrap();
    assert!(route(input).is_empty());
}

#[test]
fn stale_socket_epoch_cannot_route_notices_or_ticks() {
    let denied = ActivityInput::Notice {
        event: ActivityNotice::ChannelAccessRevoked,
        connection: Some(6),
        current_connection: Some(7),
        facts: Some(ActivityFacts::default()),
    };
    assert!(route(denied).is_empty());
    assert!(
        route(notice(
            ActivityNotice::ChannelAccessRevoked,
            ActivityFacts::default(),
        ))
        .contains(&Revoke)
    );

    let mut router = ActivityRouting::default();
    let generation = ready(&mut router);
    let denied = ActivityInput::Tick {
        generation,
        connection: Some(7),
        current_connection: Some(8),
    };
    assert!(router.step(denied, AccessLifetime::Current).is_empty());
    assert!(
        !router
            .step(tick(generation), AccessLifetime::Current)
            .is_empty()
    );
}

#[test]
fn local_invalidation_can_run_offline() {
    assert_eq!(
        route(ActivityInput::Notice {
            event: ActivityNotice::DmListChanged,
            connection: None,
            current_connection: None,
            facts: None,
        }),
        [invalidate(Dms, Access, Some(true))]
    );
}

fn assert_retired(lifetime: AccessLifetime) {
    let input = || notice(ActivityNotice::DmListChanged, ActivityFacts::default());
    let mut router = ActivityRouting::default();
    let generation = ready(&mut router);
    assert!(router.step(input(), lifetime).is_empty());
    assert!(router.step(tick(generation), lifetime).is_empty());
    assert_eq!(
        router.step(input(), AccessLifetime::Current),
        [invalidate(Dms, Access, Some(true))]
    );
    assert!(
        !router
            .step(tick(generation), AccessLifetime::Current)
            .is_empty()
    );
}

#[test]
fn retired_organization_cannot_route_notice_or_tick() {
    assert_retired(AccessLifetime::RetiredOrganization);
}

#[test]
fn replaced_session_cannot_route_notice_or_tick() {
    assert_retired(AccessLifetime::ReplacedSession);
}

#[test]
fn known_kinds_dirty_only_their_own_lists() {
    assert_eq!(
        route(notice(
            channel_activity(),
            ActivityFacts {
                kind: Some(Dm),
                ..ActivityFacts::default()
            }
        )),
        [invalidate(Dms, Notice, Some(false))]
    );
    assert_eq!(
        route(notice(
            channel_activity(),
            ActivityFacts {
                kind: Some(Channel),
                ..ActivityFacts::default()
            }
        )),
        [
            invalidate(Channels, Notice, None),
            invalidate(ArchivedChannels, Notice, None)
        ]
    );
}

#[test]
fn unknown_kind_dirties_both_lists_despite_watch_and_coverage() {
    let facts = || ActivityFacts {
        has_kind_lookup: true,
        watched: true,
        list_covered: true,
        projection_covered: true,
        ..ActivityFacts::default()
    };
    let both = [
        invalidate(Channels, Notice, None),
        invalidate(ArchivedChannels, Notice, None),
        invalidate(Dms, Notice, Some(true)),
    ];
    assert_eq!(route(notice(channel_activity(), facts())), both);
    assert_eq!(route(notice(read(false), facts())), both);
    assert!(
        route(notice(
            channel_activity(),
            ActivityFacts {
                has_kind_lookup: false,
                ..facts()
            }
        ))
        .is_empty()
    );
}

#[test]
fn known_activity_skips_watched_and_covered_lists() {
    let activity = |watched, as_of_seq| {
        route(notice(
            channel_activity(),
            ActivityFacts {
                kind: Some(Dm),
                watched,
                as_of_seq,
                ..ActivityFacts::default()
            },
        ))
    };
    assert_eq!(
        activity(false, Some(9)),
        [invalidate(Dms, Notice, Some(false))]
    );
    assert!(activity(true, Some(9)).is_empty());
    assert!(activity(false, Some(10)).is_empty());
}

#[test]
fn supplied_list_coverage_cannot_cover_a_read_projection() {
    let facts = || ActivityFacts {
        kind: Some(Channel),
        list_covered: true,
        watched: true,
        ..ActivityFacts::default()
    };
    assert!(
        route(notice(
            channel_activity(),
            ActivityFacts {
                watched: false,
                ..facts()
            }
        ))
        .is_empty()
    );
    assert_eq!(
        route(notice(read(true), facts())),
        [invalidate(Topic, Notice, None)]
    );
    assert!(
        route(notice(
            read(true),
            ActivityFacts {
                projection_covered: true,
                ..facts()
            }
        ))
        .is_empty()
    );
}

#[test]
fn read_projection_requires_a_watch_and_independent_coverage() {
    let read_effects = |topic, watched, topic_read_seq| {
        route(notice(
            read(topic),
            ActivityFacts {
                kind: Some(Channel),
                watched,
                main_read_seq: Some(10),
                topic_read_seq,
                ..ActivityFacts::default()
            },
        ))
    };
    let list = [
        invalidate(Channels, Notice, None),
        invalidate(ArchivedChannels, Notice, None),
    ];
    assert_eq!(read_effects(true, false, Some(9)), list);
    assert_eq!(read_effects(true, true, Some(10)), list);
    assert_eq!(
        read_effects(true, true, Some(9)),
        [
            invalidate(Channels, Notice, None),
            invalidate(ArchivedChannels, Notice, None),
            invalidate(Topic, Notice, None),
        ]
    );
    assert!(read_effects(false, false, Some(10)).is_empty());
    assert_eq!(
        read_effects(false, true, Some(10)),
        [invalidate(Main, Notice, None)]
    );
}

#[test]
fn access_routes_revoke_before_list_demand_and_never_opens_a_dm_as_a_channel() {
    let facts = |kind| ActivityFacts {
        kind: Some(kind),
        ..ActivityFacts::default()
    };
    assert_eq!(
        route(notice(ActivityNotice::ChannelAccessRevoked, facts(Dm))),
        [
            Revoke,
            RetireChannelMembers,
            invalidate(Dms, Access, Some(true)),
            member_lists()
        ]
    );
    assert_eq!(
        route(notice(ActivityNotice::ChannelAccessGained, facts(Channel))),
        [
            Gain,
            invalidate(Sections, Access, None),
            invalidate(Channels, Access, None),
            invalidate(ArchivedChannels, Access, None),
            invalidate(OpenChannel, Access, None),
            member_lists()
        ]
    );
}

#[test]
fn ready_and_read_prepare_before_inspecting_targets() {
    let unprepared = |event| ActivityInput::Notice {
        event,
        connection: Some(7),
        current_connection: Some(7),
        facts: None,
    };
    assert_eq!(
        route(unprepared(ActivityNotice::ActivityReady)),
        [ReadyTargets]
    );
    assert_eq!(route(unprepared(read(false))), [ObserveRead]);
    assert_eq!(route(unprepared(channel_activity())), [Inspect]);
    assert_eq!(
        ActivityRouting::default().step(
            notice(
                read(false),
                ActivityFacts {
                    kind: Some(Dm),
                    ..ActivityFacts::default()
                }
            ),
            AccessLifetime::Current,
        ),
        [invalidate(Dms, Notice, Some(false)), InspectReadProjection]
    );
}

#[test]
fn ready_replaces_the_schedule_and_reset_leaves_it_armed() {
    let mut router = ActivityRouting::default();
    let old = ready(&mut router);
    let generation = ready(&mut router);
    assert!(router.step(tick(old), AccessLifetime::Current).is_empty());
    assert_eq!(
        router.step(
            notice(ActivityNotice::ActivityReset, ActivityFacts::default()),
            AccessLifetime::Current
        ),
        [reconcile(
            ActivityReason::Reconcile,
            false,
            Some(ActivityDelay::Reset)
        )]
    );
    assert_eq!(
        router.step(tick(generation), AccessLifetime::Current),
        [
            reconcile(Periodic, false, None),
            Arm {
                generation,
                timing: ActivityDelay::Periodic
            }
        ]
    );
}

#[test]
fn disconnect_and_close_cancel_reconciliation() {
    let mut router = ActivityRouting::default();
    assert!(router.step(tick(0), AccessLifetime::Current).is_empty());
    let old = ready(&mut router);
    assert_eq!(
        router.step(ActivityInput::Disconnected, AccessLifetime::Current),
        [Cancel, DisconnectTargets]
    );
    assert!(router.step(tick(old), AccessLifetime::Current).is_empty());
    let generation = ready(&mut router);
    assert_eq!(
        router.step(ActivityInput::Close, AccessLifetime::Current),
        [Cancel, CloseTargets]
    );
    assert!(
        router
            .step(tick(generation), AccessLifetime::Current)
            .is_empty()
    );
    assert!(
        router
            .step(
                notice(ActivityNotice::ActivityReset, ActivityFacts::default()),
                AccessLifetime::Current
            )
            .is_empty()
    );
}

#[test]
fn reconciliation_delay_uses_the_supplied_draw() {
    assert_eq!(activity_delay(ActivityDelay::First, None, 0.75), 22_500.0);
    assert_eq!(
        activity_delay(ActivityDelay::First, Some(2000.0), 0.75),
        1500.0
    );
    assert_eq!(activity_delay(ActivityDelay::Periodic, None, 0.0), 27_000.0);
    assert_eq!(activity_delay(ActivityDelay::Periodic, None, 1.0), 33_000.0);
    assert_eq!(
        activity_delay(ActivityDelay::Reset, Some(2000.0), 0.75),
        1500.0
    );
}
