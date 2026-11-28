use super::*;
use crate::{Effect, Failure, Input, StepInput, Uuid};

#[test]
fn only_definite_refusals_restore_a_detached_submission_once() {
    for (result, attached, detached) in [
        (SendResult::Ack, Disposition::Drop, Disposition::Drop),
        (SendResult::Network, Disposition::Keep, Disposition::Drop),
        (
            SendResult::Http(429.0),
            Disposition::Keep,
            Disposition::Drop,
        ),
        (
            SendResult::Http(401.0),
            Disposition::Drop,
            Disposition::Drop,
        ),
        (
            SendResult::Http(500.0),
            Disposition::Drop,
            Disposition::Drop,
        ),
        (
            SendResult::Http(503.0),
            Disposition::Drop,
            Disposition::Drop,
        ),
        (
            SendResult::Http(400.5),
            Disposition::Drop,
            Disposition::Drop,
        ),
        (
            SendResult::Http(f64::NAN),
            Disposition::Drop,
            Disposition::Drop,
        ),
    ]
    .into_iter()
    .chain([400, 403, 404, 409, 413, 415].map(|status| {
        (
            SendResult::Http(f64::from(status)),
            Disposition::Drop,
            Disposition::Restore,
        )
    })) {
        let mut sends = DetachedSends::default();
        sends.track(1);
        sends.track(2);
        sends.detach(2);
        assert_eq!(sends.observe(1, result), attached, "{result:?}");
        assert_eq!(sends.observe(2, result), detached, "{result:?}");
        assert_eq!(sends.observe(2, SendResult::Http(400.0)), Disposition::Keep);
    }
}

#[test]
fn reset_releases_attached_slots_in_submission_order_and_keeps_detached_slots() {
    let mut sends = DetachedSends::default();
    for slot in 1..=6 {
        sends.track(slot);
    }
    sends.detach(5);
    sends.detach(2);
    sends.forget(3);
    sends.track(5);
    assert_eq!(sends.attached().collect::<Vec<_>>(), [1, 4, 5, 6]);
    assert_eq!(sends.reset(), [1, 4, 5, 6]);
    assert!(sends.reset().is_empty());
    assert_eq!(
        sends.observe(2, SendResult::Http(409.0)),
        Disposition::Restore
    );
    for dropped in [1, 3, 4, 5, 6] {
        assert_eq!(
            sends.observe(dropped, SendResult::Http(409.0)),
            Disposition::Keep
        );
    }
}

#[test]
fn restore_requires_both_revisions_and_an_empty_composer() {
    assert!(can_restore_draft(1.0, 1.0, Some(2.0), Some(2.0), true));
    assert!(can_restore_draft(1.0, 1.0, None, None, true));
    assert!(!can_restore_draft(1.0, 2.0, Some(2.0), Some(2.0), true));
    assert!(!can_restore_draft(1.0, 1.0, Some(2.0), Some(3.0), true));
    assert!(!can_restore_draft(1.0, 1.0, Some(2.0), Some(-1.0), true));
    assert!(!can_restore_draft(1.0, 1.0, Some(2.0), Some(2.0), false));
}

#[test]
fn only_current_unsettled_send_attempts_can_detach_across_same_key_retries() {
    let sender = Uuid::from_u128(1);
    let channel = Uuid::from_u128(2);
    let generation = Uuid::from_u128(3);
    let client_message_id = Uuid::from_u128(4);
    let mut core = Core::new(sender);
    let step = |core: &mut Core, input| {
        core.step(StepInput {
            input,
            refresh_mention_names: false,
        })
    };
    step(&mut core, Input::SessionStart { self_id: sender });
    step(&mut core, Input::Watch { channel });
    step(
        &mut core,
        Input::HistoryGeneration {
            generation: Some(generation),
        },
    );
    let mut send = step(
        &mut core,
        Input::UserSend {
            channel,
            client_message_id,
            body: "message".into(),
            reply_to: None,
            topic_name: Some("Release".into()),
            reply_root_id: None,
        },
    );
    let attempt = |effects: &[Effect]| {
        let [
            Effect::Send {
                id,
                client_message_id: key,
                body,
                topic_name,
                ..
            },
        ] = effects
        else {
            panic!("expected one send: {effects:?}");
        };
        assert_eq!(*key, client_message_id);
        assert_eq!(body, "message");
        assert_eq!(topic_name.as_deref(), Some("Release"));
        *id
    };
    for status in [Failure::Status(429), Failure::Other("network".into())] {
        let request = attempt(&send.effects);
        assert!(core.can_detach_send(request));
        let failed = step(
            &mut core,
            Input::SendFailed {
                request,
                status,
                retry_after_ms: None,
                error: None,
            },
        );
        assert!(!core.can_detach_send(request));
        send = if let [Effect::Wait { id, .. }] = failed.effects.as_slice() {
            step(&mut core, Input::TimerElapsed { id: *id })
        } else {
            step(
                &mut core,
                Input::UserRetry {
                    channel,
                    client_message_id,
                },
            )
        };
    }
    let request = attempt(&send.effects);
    assert!(core.can_detach_send(request));
    let next_generation = Uuid::from_u128(5);
    step(
        &mut core,
        Input::HistoryGeneration {
            generation: Some(next_generation),
        },
    );
    assert!(core.request(request).unwrap().stale());
    assert!(!core.can_detach_send(request));
    let send = step(
        &mut core,
        Input::UserRetry {
            channel,
            client_message_id,
        },
    );
    let request = attempt(&send.effects);
    assert!(core.can_detach_send(request));

    let mut confirmed = crate::test_support::message(1, 1);
    confirmed["history_generation"] = serde_json::json!(next_generation);
    confirmed["sender"] = serde_json::json!(sender);
    confirmed["channel_id"] = serde_json::json!(channel);
    confirmed["client_message_id"] = serde_json::json!(client_message_id);
    step(
        &mut core,
        Input::SettleHistory {
            channel,
            messages: vec![serde_json::from_value(confirmed).unwrap()],
        },
    );
    assert!(core.request(request).is_some());
    assert!(!core.can_detach_send(request));
}
