use super::*;
use fukulow_api::MessagePage;

const A: Uuid = Uuid::from_u128(1);
const B: Uuid = Uuid::from_u128(2);
const SELF: Uuid = Uuid::from_u128(3);
const OLD: Uuid = Uuid::from_u128(5);
// Generations are opaque; a new UUID can compare lower than the old one.
const NEW: Uuid = Uuid::from_u128(4);

fn step(core: &mut Core, input: Input) -> StepResult {
    core.step(StepInput {
        input,
        refresh_mention_names: false,
    })
}

fn started() -> Core {
    let mut core = Core::new(SELF);
    step(&mut core, Input::SessionStart { self_id: SELF });
    core
}

fn watch(core: &mut Core, channel: Uuid) {
    step(core, Input::Watch { channel });
    let request = core.channel(channel).unwrap().latest.unwrap();
    step(
        core,
        Input::HistoryResult {
            request,
            page: MessagePage {
                history_generation: core.session().history_generation.unwrap_or(OLD),
                as_of_seq: 10,
                messages: vec![],
                has_more: false,
            },
        },
    );
}

fn observe(
    core: &mut Core,
    issue: Option<Token>,
    lifetime: AccessLifetime,
    result: HistoryObservation,
) -> StepResult {
    step(
        core,
        Input::ObserveHistoryGeneration {
            issue,
            lifetime,
            result,
        },
    )
}

fn current(core: &mut Core, result: HistoryObservation) -> StepResult {
    observe(core, core.history_issue(), AccessLifetime::Current, result)
}

fn generation(value: Uuid) -> HistoryObservation {
    HistoryObservation::Success {
        generation: Some(value),
    }
}

fn failure(status: Failure, error: &str) -> HistoryObservation {
    HistoryObservation::Failure {
        status,
        error: Some(error.to_owned()),
    }
}

fn conflict() -> HistoryObservation {
    failure(Failure::Status(409), "history_generation_changed")
}

fn assert_no_change(result: &StepResult, expected: HistoryObservationResult) {
    assert_eq!(result.history_observation, Some(expected));
    assert!(!result.state_changed);
    assert!(result.effects.is_empty());
}

#[test]
fn only_a_current_generation_or_its_exact_conflict_can_reset_history() {
    use HistoryObservationResult::*;
    let cases = [
        (None, false, generation(OLD), Accepted),
        (Some(OLD), false, generation(OLD), Accepted),
        (Some(OLD), false, generation(NEW), Reset),
        (None, false, conflict(), Reset),
        (Some(OLD), false, conflict(), Reset),
        (
            Some(OLD),
            false,
            HistoryObservation::Success { generation: None },
            Ignored,
        ),
        (
            Some(OLD),
            true,
            HistoryObservation::Success { generation: None },
            Stale,
        ),
        (Some(OLD), true, generation(OLD), Stale),
        (Some(OLD), true, generation(NEW), Stale),
        (Some(OLD), true, conflict(), Ignored),
        (
            Some(OLD),
            false,
            failure(Failure::Status(409), "snapshot_expired"),
            Ignored,
        ),
        (
            Some(OLD),
            false,
            failure(Failure::Status(404), "history_generation_changed"),
            Ignored,
        ),
        (
            Some(OLD),
            false,
            failure(
                Failure::Other("network".to_owned()),
                "history_generation_changed",
            ),
            Ignored,
        ),
        (
            Some(OLD),
            false,
            failure(Failure::Status(401), "history_generation_changed"),
            Ignored,
        ),
    ];
    for (known, stale, result, expected) in cases {
        let mut core = started();
        let issue = core.history_issue();
        if stale {
            current(&mut core, conflict());
        }
        if let Some(known) = known {
            current(&mut core, generation(known));
        }
        let epoch = core.session().history_epoch;
        let before = core.session().history_generation;
        let input = format!("{result:?} with {known:?} and stale={stale}");
        let out = observe(&mut core, issue, AccessLifetime::Current, result);
        assert_eq!(out.history_observation, Some(expected), "{input}");
        assert_eq!(
            core.session().history_epoch,
            epoch + u64::from(expected == Reset),
            "{input}"
        );
        if matches!(expected, Stale | Ignored) {
            assert_eq!(core.session().history_generation, before, "{input}");
            assert_no_change(&out, expected);
        }
    }
}

#[test]
fn an_older_prefetched_generation_cannot_supersede_a_known_generation() {
    use HistoryObservationResult::*;
    let mut core = started();
    let prefetched = |generation| HistoryObservation::Prefetched { generation };
    assert_no_change(&current(&mut core, prefetched(Some(OLD))), Accepted);
    current(&mut core, generation(NEW));
    for late in [None, Some(OLD)] {
        assert_no_change(&current(&mut core, prefetched(late)), Stale);
    }
    assert_no_change(&current(&mut core, prefetched(Some(NEW))), Accepted);
    assert_eq!(core.session().history_generation, Some(NEW));
}

#[test]
fn an_ordinary_request_issued_before_session_start_cannot_observe_history() {
    use HistoryObservationResult::*;
    let mut core = Core::new(SELF);
    let issue = core.history_issue();
    assert_eq!(issue, None);
    step(&mut core, Input::SessionStart { self_id: SELF });
    assert_no_change(
        &observe(&mut core, issue, AccessLifetime::Current, generation(OLD)),
        Stale,
    );
    assert_no_change(
        &observe(&mut core, issue, AccessLifetime::Current, conflict()),
        Ignored,
    );
    assert_eq!(core.session().history_generation, None);
}

#[test]
fn stale_issue_cannot_roll_back_a_generation_or_apply_a_conflict() {
    use HistoryObservationResult::*;
    let mut core = started();
    current(&mut core, generation(OLD));
    let issue = core.history_issue();
    assert_eq!(
        current(&mut core, generation(NEW)).history_observation,
        Some(Reset)
    );
    for (result, expected) in [(generation(OLD), Stale), (conflict(), Ignored)] {
        let out = observe(&mut core, issue, AccessLifetime::Current, result);
        assert_no_change(&out, expected);
    }
    assert_eq!(core.session().history_generation, Some(NEW));
    assert_eq!(core.session().history_epoch, 1);
}

#[test]
fn noncurrent_lifetimes_deny_generation_observation() {
    use HistoryObservationResult::*;
    let mut core = started();
    watch(&mut core, A);
    let issue = core.history_issue();
    for lifetime in [
        AccessLifetime::StaleRequest,
        AccessLifetime::RetiredOrganization,
        AccessLifetime::ReplacedSession,
    ] {
        assert_no_change(
            &observe(&mut core, issue, lifetime, generation(NEW)),
            Ignored,
        );
        assert_no_change(&observe(&mut core, issue, lifetime, conflict()), Ignored);
    }
}

#[test]
fn stopped_organization_and_replaced_session_fence_issued_observations() {
    use HistoryObservationResult::*;
    let mut core = started();
    watch(&mut core, A);
    let issue = core.history_issue();
    step(&mut core, Input::OrganizationUnavailable);
    assert_no_change(
        &observe(&mut core, issue, AccessLifetime::Current, conflict()),
        Ignored,
    );
    assert_no_change(
        &current(
            &mut core,
            HistoryObservation::Prefetched {
                generation: Some(OLD),
            },
        ),
        Ignored,
    );
    step(&mut core, Input::SessionReplaced { self_id: SELF });
    assert_no_change(
        &observe(&mut core, issue, AccessLifetime::Current, generation(NEW)),
        Stale,
    );
}

#[test]
fn an_ordinary_reconnect_preserves_the_organization_issue() {
    let mut core = started();
    let issue = core.history_issue();
    let connection = core.session().connection.unwrap();
    step(&mut core, Input::ConnectionReady { connection });
    let closed = step(
        &mut core,
        Input::SocketClosed {
            connection,
            code: 1001,
        },
    );
    let [Effect::Wait { id, .. }] = closed.effects.as_slice() else {
        panic!("expected reconnect wait, got {:?}", closed.effects);
    };
    step(&mut core, Input::TimerElapsed { id: *id });
    assert_ne!(core.session().connection, Some(connection));
    assert_eq!(core.history_issue(), issue);
    let out = observe(&mut core, issue, AccessLifetime::Current, generation(NEW));
    assert_eq!(
        out.history_observation,
        Some(HistoryObservationResult::Accepted)
    );
}

#[test]
fn organization_conflict_restarts_watched_channels_and_clears_inactive_history() {
    let mut core = started();
    watch(&mut core, A);
    watch(&mut core, B);
    step(&mut core, Input::Unwatch { channel: B });
    assert_eq!(core.channel(B).unwrap().cursor, Some(10));
    let issue = core.history_issue();

    let out = current(&mut core, conflict());

    assert_eq!(
        out.history_observation,
        Some(HistoryObservationResult::Reset)
    );
    assert_eq!(out.changed_channels, [A, B]);
    assert!(matches!(
        out.effects.as_slice(),
        [
            Effect::Connect { .. },
            Effect::FetchHistory { channel: A, .. }
        ]
    ));
    assert_eq!(core.channel(A).unwrap().cursor, None);
    assert_eq!(core.channel(B).unwrap().cursor, None);
    assert_eq!(core.session().history_generation, None);
    assert_eq!(core.session().history_epoch, 1);
    assert_ne!(core.history_issue(), issue);
}

#[test]
fn organization_observation_restarts_all_channels_and_keeps_late_401_authoritative() {
    let mut core = started();
    watch(&mut core, A);
    watch(&mut core, B);
    let connection = core.session().connection.unwrap();
    step(&mut core, Input::ConnectionReady { connection });
    let send = step(
        &mut core,
        Input::UserSend {
            channel: B,
            client_message_id: SELF,
            body: "pending".to_owned(),
            reply_to: None,
            reply_root_id: None,
            topic_name: None,
        },
    );
    let [Effect::Send { id, .. }] = send.effects.as_slice() else {
        panic!("expected a send, got {:?}", send.effects);
    };
    let out = current(&mut core, generation(NEW));
    assert_eq!(
        out.history_observation,
        Some(HistoryObservationResult::Reset)
    );
    assert_eq!(out.changed_channels, [A, B]);
    assert!(matches!(
        out.effects.as_slice(),
        [
            Effect::Unsubscribe { channel: A },
            Effect::Unsubscribe { channel: B },
            Effect::Connect { .. },
            Effect::FetchHistory { channel: A, .. },
            Effect::FetchHistory { channel: B, .. }
        ]
    ));
    assert_eq!(core.channel(A).unwrap().cursor, None);
    assert_eq!(core.channel(B).unwrap().cursor, None);
    assert_eq!(core.session().history_generation, Some(NEW));
    assert_eq!(
        core.channel(B).unwrap().pending[0].state,
        PendingState::Unknown
    );
    assert!(core.request(*id).unwrap().stale());
    step(
        &mut core,
        Input::SendFailed {
            request: *id,
            status: Failure::Status(401),
            retry_after_ms: None,
            error: None,
        },
    );
    assert_eq!(core.session().session, Session::SignInRequired);
}
