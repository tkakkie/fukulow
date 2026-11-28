use crate::*;
use fukulow_api::{MessagePage, ServerEvent};

const A: Uuid = Uuid::from_u128(1);
const B: Uuid = Uuid::from_u128(2);
const SELF: Uuid = Uuid::from_u128(3);
const GENERATION: Uuid = Uuid::from_u128(4);

fn step(core: &mut Core, input: Input) -> StepResult {
    core.step(StepInput {
        input,
        refresh_mention_names: false,
    })
}

fn connection(core: &Core) -> Token {
    core.session().connection.unwrap()
}

fn ready(core: &mut Core) {
    let connection = connection(core);
    step(core, Input::ConnectionReady { connection });
}

fn started() -> Core {
    let mut core = Core::new(SELF);
    step(&mut core, Input::SessionStart { self_id: SELF });
    ready(&mut core);
    core
}

fn watch(core: &mut Core, channel: Uuid) -> Token {
    let already_loaded = core.channel(channel).is_some_and(|c| c.cursor.is_some());
    step(core, Input::Watch { channel });
    if !already_loaded {
        let request = core.channel(channel).unwrap().latest.unwrap();
        step(
            core,
            Input::HistoryResult {
                request,
                page: MessagePage {
                    history_generation: GENERATION,
                    as_of_seq: 0,
                    messages: vec![],
                    has_more: false,
                },
            },
        );
    }
    core.channel(channel)
        .unwrap()
        .subscription
        .as_ref()
        .unwrap()
        .id
}

fn issue(core: &mut Core, channel: Uuid, id: Token) {
    core.subscribe_issued(connection(core), channel, id);
}

fn rewatch(core: &mut Core, channel: Uuid) -> Token {
    step(core, Input::Unwatch { channel });
    watch(core, channel)
}

fn frame(core: &mut Core, event: ServerEvent) -> StepResult {
    let connection = connection(core);
    step(core, Input::SocketFrame { connection, event })
}

fn subscribed(channel_id: Uuid) -> ServerEvent {
    ServerEvent::Subscribed {
        channel_id,
        history_generation: GENERATION,
        caught_up_seq: 0,
    }
}

fn error(channel_id: Option<Uuid>, code: &str) -> ServerEvent {
    ServerEvent::Error {
        channel_id,
        code: code.to_owned(),
    }
}

fn losses() -> [ServerEvent; 2] {
    [
        ServerEvent::ChannelAccessLost { channel_id: A },
        error(Some(A), "channel_not_found"),
    ]
}

fn attributed(result: StepResult, expected: Option<Token>) {
    assert!(
        matches!(result.socket_delivery, Some(SocketDelivery::Sync { subscription }) if subscription == expected),
        "expected {expected:?}, got {result:?}"
    );
}

fn confirmed(core: &Core, channel: Uuid) -> bool {
    core.channel(channel)
        .and_then(|c| c.subscription.as_ref())
        .is_some_and(|s| s.confirmed)
}

fn assert_reconnect(core: &Core, connection: Token, result: StepResult) {
    assert!(result.socket_delivery.is_none());
    assert!(
        matches!(
            result.effects.as_slice(),
            [
                Effect::Wait { purpose: Purpose::ReconnectBackoff, id, attempt: Some(0), .. },
                Effect::CloseConnection { connection: closing },
            ] if *closing == connection && Some(*id) == core.session().reconnect_wait
        ),
        "{result:?}"
    );
    assert!(!core.session().connected);
    assert!(core.channel(A).unwrap().watched);
    assert_ne!(core.channel(A).unwrap().state, Availability::Unavailable);
}

#[test]
fn fifo_replies_cannot_confirm_or_refuse_a_later_watch() {
    for reply in [
        subscribed(A),
        error(Some(A), "subscription_limit"),
        error(Some(A), "channel_not_found"),
    ] {
        let mut core = started();
        let old = watch(&mut core, A);
        issue(&mut core, A, old);
        let other = watch(&mut core, B);
        issue(&mut core, B, other);
        let current = rewatch(&mut core, A);
        issue(&mut core, A, current);

        attributed(frame(&mut core, subscribed(B)), Some(other));
        assert!(confirmed(&core, B));
        let result = frame(&mut core, reply);
        assert!(!result.state_changed);
        attributed(result, Some(old));
        assert!(!confirmed(&core, A));
        assert_eq!(core.channel(A).unwrap().state, Availability::Loading);
        attributed(frame(&mut core, subscribed(A)), Some(current));
        assert!(confirmed(&core, A));
    }
}

#[test]
fn unwatched_loss_consumes_late_replies_without_reconnect() {
    for loss in losses() {
        let mut core = started();
        let old = watch(&mut core, A);
        issue(&mut core, A, old);
        frame(&mut core, subscribed(A));
        let pending = rewatch(&mut core, A);
        issue(&mut core, A, pending);
        step(&mut core, Input::Unwatch { channel: A });

        let result = frame(&mut core, loss);
        assert!(!result.state_changed);
        attributed(result, Some(pending));
        attributed(frame(&mut core, subscribed(A)), Some(-1));
        assert!(core.session().connected);
        assert!(!core.channel(A).unwrap().watched);
        assert_ne!(core.channel(A).unwrap().state, Availability::Unavailable);
        assert!(core.socket_replies.0[&A].confirmed.is_none());

        let unrelated = frame(&mut core, ServerEvent::ChannelAccessLost { channel_id: B });
        assert!(!unrelated.state_changed);
        attributed(unrelated, Some(-1));
        assert!(core.channel(B).is_none());
    }
}

#[test]
fn confirmed_loss_only_denies_the_attributed_channel() {
    for loss in losses() {
        let mut core = started();
        let id = watch(&mut core, A);
        issue(&mut core, A, id);
        frame(&mut core, subscribed(A));
        let other = watch(&mut core, B);
        issue(&mut core, B, other);
        frame(&mut core, subscribed(B));

        attributed(frame(&mut core, loss), Some(id));
        assert_eq!(core.channel(A).unwrap().state, Availability::Unavailable);
        assert!(core.session().connected);
        assert!(confirmed(&core, B));

        let duplicate = frame(&mut core, ServerEvent::ChannelAccessLost { channel_id: A });
        assert!(duplicate.effects.is_empty());
        attributed(duplicate, Some(-1));
    }
}

#[test]
fn access_loss_without_a_matching_confirmation_reconnects_with_backoff() {
    for (confirm_old, issue_current) in [(false, false), (false, true), (true, false), (true, true)]
    {
        let mut core = started();
        let first = watch(&mut core, A);
        let current = if confirm_old {
            issue(&mut core, A, first);
            frame(&mut core, subscribed(A));
            rewatch(&mut core, A)
        } else {
            first
        };
        if issue_current {
            issue(&mut core, A, current);
        }
        let connection = connection(&core);
        let result = frame(&mut core, ServerEvent::ChannelAccessLost { channel_id: A });
        assert_reconnect(&core, connection, result);
    }
    let mut core = started();
    step(&mut core, Input::Watch { channel: A });
    let connection = connection(&core);
    let result = frame(&mut core, ServerEvent::ChannelAccessLost { channel_id: A });
    assert_reconnect(&core, connection, result);
}

#[test]
fn channel_not_found_reconnects_until_new_subscribed_handoff() {
    for handoff in [false, true] {
        for loss in losses() {
            let mut core = started();
            let old = watch(&mut core, A);
            issue(&mut core, A, old);
            frame(&mut core, subscribed(A));
            let current = rewatch(&mut core, A);
            issue(&mut core, A, current);
            if handoff {
                attributed(frame(&mut core, subscribed(A)), Some(current));
            }
            let connection = connection(&core);
            let result = frame(&mut core, loss);
            if handoff {
                attributed(result, Some(current));
                assert_eq!(core.channel(A).unwrap().state, Availability::Unavailable);
                assert!(core.session().connected);
            } else {
                assert_reconnect(&core, connection, result);
            }
        }
    }
}

#[test]
fn error_codes_consume_only_reply_slots_and_preserve_other_transitions() {
    for refusal in ["channel_not_found", "subscription_limit"] {
        let mut core = started();
        let id = watch(&mut core, A);
        issue(&mut core, A, id);
        attributed(frame(&mut core, error(None, refusal)), None);
        attributed(frame(&mut core, error(Some(A), "invalid_message")), None);
        assert!(!confirmed(&core, A));
        attributed(frame(&mut core, error(Some(A), refusal)), Some(id));
        assert_eq!(core.channel(A).unwrap().state, Availability::Unavailable);
        assert!(core.socket_replies.0[&A].confirmed.is_none());
        assert!(core.session().connected);
    }

    let mut core = started();
    let id = watch(&mut core, A);
    issue(&mut core, A, id);
    frame(&mut core, subscribed(A));
    attributed(frame(&mut core, subscribed(A)), Some(-1));
    attributed(
        frame(&mut core, error(Some(A), "subscription_limit")),
        Some(-1),
    );
    assert!(confirmed(&core, A));
    attributed(
        frame(&mut core, error(Some(A), "channel_not_found")),
        Some(id),
    );

    let id = watch(&mut core, A);
    issue(&mut core, A, id);
    let old = connection(&core);
    attributed(
        frame(&mut core, error(Some(A), "history_generation_changed")),
        None,
    );
    assert_ne!(connection(&core), old);
    assert_eq!(core.session().history_epoch, 1);
}

#[test]
fn subscribe_issuance_and_frames_are_fenced_by_connection() {
    let mut core = started();
    let old = connection(&core);
    let confirmed_id = watch(&mut core, A);
    issue(&mut core, A, confirmed_id);
    frame(&mut core, subscribed(A));
    let pending_id = rewatch(&mut core, A);
    issue(&mut core, A, pending_id);

    step(&mut core, Input::HistoryGeneration { generation: None });
    let new = connection(&core);
    assert_ne!(old, new);
    assert!(core.socket_replies.0.is_empty());
    core.subscribe_issued(new, A, pending_id);
    assert!(core.socket_replies.0.is_empty());
    ready(&mut core);
    core.subscribe_issued(old, A, pending_id);
    assert!(core.socket_replies.0.is_empty());
    let request = core.channel(A).unwrap().latest.unwrap();
    step(
        &mut core,
        Input::HistoryResult {
            request,
            page: MessagePage {
                history_generation: GENERATION,
                as_of_seq: 0,
                messages: vec![],
                has_more: false,
            },
        },
    );
    let current = core.channel(A).unwrap().subscription.as_ref().unwrap().id;
    // A subscription effect alone does not make an unobserved send count as issued.
    attributed(frame(&mut core, subscribed(A)), Some(-1));
    assert!(!confirmed(&core, A));
    issue(&mut core, A, current);
    let stale = step(
        &mut core,
        Input::SocketFrame {
            connection: old,
            event: subscribed(A),
        },
    );
    assert!(stale.socket_delivery.is_none());
    assert!(!stale.state_changed);
    attributed(frame(&mut core, subscribed(A)), Some(current));
    assert!(confirmed(&core, A));
    step(
        &mut core,
        Input::SocketClosed {
            connection: new,
            code: 1006,
        },
    );
    assert!(core.socket_replies.0.is_empty());
}

#[test]
fn activity_is_delivered_only_from_the_current_running_connection() {
    let mut core = Core::new(SELF);
    step(&mut core, Input::SessionStart { self_id: SELF });
    let connection = connection(&core);
    let result = frame(&mut core, ServerEvent::ActivityReady);
    assert!(matches!(
        result.socket_delivery,
        Some(SocketDelivery::Activity)
    ));
    assert!(!result.state_changed);
    assert!(!core.session().connected);
    step(&mut core, Input::Watch { channel: A });
    let result = frame(&mut core, ServerEvent::ChannelAccessLost { channel_id: A });
    assert!(result.effects.is_empty());
    assert!(result.socket_delivery.is_none());
    step(&mut core, Input::Unwatch { channel: A });
    ready(&mut core);
    let id = watch(&mut core, A);
    issue(&mut core, A, id);
    step(&mut core, Input::OrganizationUnavailable);
    assert!(core.socket_replies.0.is_empty());
    let result = step(
        &mut core,
        Input::SocketFrame {
            connection,
            event: ServerEvent::ActivityReady,
        },
    );
    assert!(result.socket_delivery.is_none());
    assert!(!result.state_changed);
}
