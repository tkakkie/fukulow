use super::*;
use crate::{
    Availability, Core, Effect, Failure, Input, Organization, Purpose, Session, StepInput, Token,
    Uuid,
};

fn step(core: &mut Core, input: Input) -> Vec<Effect> {
    core.step(StepInput {
        input,
        refresh_mention_names: false,
    })
    .effects
}

fn started() -> (Core, Token) {
    let self_id = Uuid::from_u128(1);
    let mut core = Core::new(self_id);
    step(&mut core, Input::SessionStart { self_id });
    let connection = core.session().connection.unwrap();
    (core, connection)
}

fn disconnect(
    core: &mut Core,
    connection: Token,
    code: u16,
    opened: bool,
    opaque: bool,
) -> Vec<Effect> {
    if opened {
        step(core, Input::ConnectionReady { connection });
    }
    step(
        core,
        Input::SocketDisconnected {
            connection,
            code,
            opened,
            opaque,
        },
    )
}

#[derive(Debug, PartialEq, Eq)]
enum SocketOutcome {
    Probe,
    Reconnect,
    AccountEnded,
    OrganizationUnavailable(Option<Token>),
}

fn socket_outcome(effects: &[Effect]) -> SocketOutcome {
    match effects {
        [Effect::CheckMembership { .. }] => SocketOutcome::Probe,
        [
            Effect::Wait {
                purpose: Purpose::ReconnectBackoff,
                ..
            },
        ] => SocketOutcome::Reconnect,
        [Effect::Close, Effect::SignIn] => SocketOutcome::AccountEnded,
        [Effect::ReportOrganizationUnavailable { socket }] => {
            SocketOutcome::OrganizationUnavailable(socket.as_ref().map(|socket| {
                assert_eq!(socket.code, 4003);
                socket.connection
            }))
        }
        _ => panic!("unexpected effects: {effects:?}"),
    }
}

#[test]
fn socket_disconnection_matches_the_previous_controller_table() {
    use SocketOutcome::*;

    for code in [4001, 4003, 4008, 1001, 1011, 4029, 1006, 1000, 4999] {
        for opened in [false, true] {
            for opaque in [false, true] {
                let (mut core, connection) = started();
                // The old controller used the REST probe before interpreting a pre-open code.
                let previous = if opened || !opaque {
                    match code {
                        4001 => AccountEnded,
                        4003 => OrganizationUnavailable(Some(connection)),
                        _ => Reconnect,
                    }
                } else {
                    Probe
                };
                let effects = disconnect(&mut core, connection, code, opened, opaque);
                assert_eq!(
                    socket_outcome(&effects),
                    previous,
                    "{code}, opened={opened}, opaque={opaque}"
                );
                match previous {
                    Probe | OrganizationUnavailable(_) => {
                        assert_eq!(core.session().connection, Some(connection));
                        assert_eq!(core.session().organization, Organization::Available);
                    }
                    Reconnect => {
                        assert_eq!(core.session().connection, None);
                        assert_eq!(core.session().session, Session::SignedIn);
                    }
                    AccountEnded => {
                        assert_eq!(core.session().session, Session::SignInRequired);
                        assert!(!core.session().running);
                    }
                }
            }
        }
    }
}

#[test]
fn rejected_handshake_uses_only_rest_confirmed_membership_loss() {
    use SocketOutcome::*;

    for (status, code, expected) in [
        (None, None, Reconnect),
        (Some(Failure::Status(401)), None, AccountEnded),
        (
            Some(Failure::Status(404)),
            Some("organization_unavailable"),
            OrganizationUnavailable(None),
        ),
        (
            Some(Failure::Status(403)),
            Some("organization_unavailable"),
            Reconnect,
        ),
        (
            Some(Failure::Status(403)),
            Some("origin_not_allowed"),
            Reconnect,
        ),
        (
            Some(Failure::Status(404)),
            Some("channel_not_found"),
            Reconnect,
        ),
        (
            Some(Failure::Other("network".into())),
            Some("organization_unavailable"),
            Reconnect,
        ),
        (Some(Failure::Status(503)), None, Reconnect),
    ] {
        let (mut core, connection) = started();
        let effects = disconnect(&mut core, connection, 4003, false, true);
        assert!(
            matches!(&effects[..], [Effect::CheckMembership { connection: checked }] if *checked == connection)
        );
        let effects = step(
            &mut core,
            Input::MembershipChecked {
                connection,
                status,
                error: code.map(str::to_owned),
            },
        );
        assert_eq!(socket_outcome(&effects), expected);
        if expected == OrganizationUnavailable(None) {
            assert!(matches!(
                &step(&mut core, Input::OrganizationUnavailable)[..],
                [Effect::Close]
            ));
            assert_eq!(core.session().organization, Organization::Unavailable);
        } else {
            assert_eq!(core.session().organization, Organization::Available);
        }
    }
}

#[test]
fn socket_and_probe_results_cannot_affect_a_replacement_connection() {
    let (mut core, old) = started();
    assert_eq!(
        socket_outcome(&disconnect(&mut core, old, 1006, false, true)),
        SocketOutcome::Probe
    );
    let self_id = core.session().self_id;
    step(&mut core, Input::SessionReplaced { self_id });
    let current = core.session().connection.unwrap();

    assert!(disconnect(&mut core, old, 4003, false, true).is_empty());
    assert!(
        step(
            &mut core,
            Input::SocketClosed {
                connection: old,
                code: 4003
            }
        )
        .is_empty()
    );
    let checked = |connection, status, error| Input::MembershipChecked {
        connection,
        status: Some(Failure::Status(status)),
        error,
    };
    assert!(step(&mut core, checked(current, 401, None)).is_empty());
    assert_eq!(
        socket_outcome(&disconnect(&mut core, current, 1006, false, true)),
        SocketOutcome::Probe
    );
    assert!(step(&mut core, checked(old, 401, None)).is_empty());
    assert!(
        step(
            &mut core,
            checked(old, 404, Some("organization_unavailable".into()))
        )
        .is_empty()
    );
    assert_eq!(core.session().connection, Some(current));
    assert_eq!(core.session().session, Session::SignedIn);
    assert_eq!(core.session().organization, Organization::Available);
    assert_eq!(
        socket_outcome(&step(&mut core, checked(current, 403, None))),
        SocketOutcome::Reconnect
    );
}

#[test]
fn rest_denials_respect_the_endpoint_context() {
    use AccessEndpoint::*;
    use AccessOutcome::*;

    let endpoints = [Organization, Capabilities, History, Send];
    for (status, code, expected) in [
        (
            Some(401),
            Some("organization_unavailable"),
            [AccountEnded; 4],
        ),
        (
            Some(404),
            Some("organization_unavailable"),
            [OrganizationUnavailable; 4],
        ),
        (
            Some(403),
            Some("organization_unavailable"),
            [LocalOutcome, LocalRefusal, ChannelUnavailable, LocalRefusal],
        ),
        (
            Some(403),
            Some("forbidden"),
            [LocalOutcome, LocalOutcome, ChannelUnavailable, LocalRefusal],
        ),
        (
            Some(404),
            Some("channel not found"),
            [LocalOutcome, LocalOutcome, ChannelUnavailable, LocalRefusal],
        ),
        (
            Some(404),
            None,
            [LocalOutcome, LocalOutcome, ChannelUnavailable, LocalRefusal],
        ),
        (
            Some(409),
            None,
            [LocalOutcome, LocalOutcome, LocalOutcome, LocalRefusal],
        ),
        (Some(429), None, [LocalOutcome; 4]),
        (None, Some("organization_unavailable"), [LocalOutcome; 4]),
    ] {
        for (endpoint, expected) in endpoints.into_iter().zip(expected) {
            assert_eq!(
                access_outcome(endpoint, AccessLifetime::Current, status, code),
                expected,
                "{endpoint:?}, {status:?}, {code:?}"
            );
        }
    }
}

#[test]
fn late_401_ends_only_the_same_account_session() {
    use AccessEndpoint::*;
    use AccessLifetime::*;
    use AccessOutcome::*;

    for endpoint in [Organization, Capabilities, History, Send] {
        for lifetime in [Current, StaleRequest, RetiredOrganization] {
            assert_eq!(
                access_outcome(endpoint, lifetime, Some(401), None),
                AccountEnded
            );
        }
        assert_eq!(
            access_outcome(endpoint, ReplacedSession, Some(401), None),
            Ignored
        );
        for lifetime in [StaleRequest, RetiredOrganization, ReplacedSession] {
            assert_eq!(
                access_outcome(
                    endpoint,
                    lifetime,
                    Some(404),
                    Some("organization_unavailable")
                ),
                Ignored
            );
        }
    }
}

#[test]
fn stale_history_and_send_failures_cannot_apply_access_denials() {
    let (mut core, _) = started();
    let channel = Uuid::from_u128(2);
    step(&mut core, Input::Watch { channel });
    let history = core.channel(channel).unwrap().latest.unwrap();
    step(
        &mut core,
        Input::UserSend {
            channel,
            client_message_id: Uuid::from_u128(3),
            body: "message".into(),
            reply_to: None,
            topic_name: None,
            reply_root_id: None,
        },
    );
    let send = core.channel(channel).unwrap().pending[0].request;
    step(&mut core, Input::HistoryGeneration { generation: None });
    assert!(core.request(history).unwrap().stale());
    assert!(core.request(send).unwrap().stale());

    assert!(
        step(
            &mut core,
            Input::HistoryFailed {
                request: history,
                status: Failure::Status(403),
                error: None
            }
        )
        .is_empty()
    );
    assert!(
        step(
            &mut core,
            Input::SendFailed {
                request: send,
                status: Failure::Status(404),
                error: Some("organization_unavailable".into()),
                retry_after_ms: None
            }
        )
        .is_empty()
    );
    assert_eq!(core.session().organization, Organization::Available);
    assert_ne!(
        core.channel(channel).unwrap().state,
        Availability::Unavailable
    );
}

#[test]
fn history_channel_denial_has_no_automatic_recovery_and_leaves_other_channels_active() {
    let (mut core, connection) = started();
    let denied = Uuid::from_u128(2);
    let other = Uuid::from_u128(3);
    for channel in [denied, other] {
        step(&mut core, Input::Watch { channel });
    }
    let request = core.channel(denied).unwrap().latest.unwrap();
    assert!(
        step(
            &mut core,
            Input::HistoryFailed {
                request,
                status: Failure::Status(403),
                error: None
            }
        )
        .is_empty()
    );
    assert_eq!(
        core.channel(denied).unwrap().state,
        Availability::Unavailable
    );
    assert_ne!(
        core.channel(other).unwrap().state,
        Availability::Unavailable
    );
    assert!(core.channel(other).unwrap().latest.is_some());
    assert!(step(&mut core, Input::ConnectionReady { connection }).is_empty());
    assert_eq!(core.channel(denied).unwrap().latest, None);
    assert_eq!(core.session().organization, Organization::Available);
    assert_eq!(core.session().session, Session::SignedIn);
}

#[test]
fn history_and_send_apply_organization_loss_to_the_whole_organization() {
    let channel = Uuid::from_u128(2);
    let other = Uuid::from_u128(3);
    for is_send in [false, true] {
        let (mut core, _) = started();
        for channel in [channel, other] {
            step(&mut core, Input::Watch { channel });
        }
        step(
            &mut core,
            Input::UserSend {
                channel,
                client_message_id: Uuid::from_u128(4),
                body: "message".into(),
                reply_to: None,
                topic_name: None,
                reply_root_id: None,
            },
        );
        let state = core.channel(channel).unwrap();
        let status = Failure::Status(404);
        let error = Some("organization_unavailable".into());
        let input = if is_send {
            Input::SendFailed {
                request: state.pending[0].request,
                status,
                error,
                retry_after_ms: None,
            }
        } else {
            Input::HistoryFailed {
                request: state.latest.unwrap(),
                status,
                error,
            }
        };
        assert!(matches!(&step(&mut core, input)[..], [Effect::Close]));
        assert_eq!(core.session().organization, Organization::Unavailable);
        assert_eq!(core.session().session, Session::SignedIn);
        assert_eq!(
            core.channel(other).unwrap().state,
            Availability::Unavailable
        );
        assert_eq!(
            core.channel(channel).unwrap().pending[0].state,
            crate::PendingState::Failed
        );
    }
}
