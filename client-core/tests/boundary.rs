use fukulow_client_core::{Core, StepInput};
use serde_json::json;
use std::{error::Error, rc::Rc};
use uuid::Uuid;

#[test]
fn production_ids_are_uuids_and_negative_subscription_fences_are_valid() {
    for input in [
        json!({"type":"watch","channel":"A"}),
        json!({"type":"session_start","selfId":"me"}),
        json!({"type":"user_send","channel":Uuid::nil(),"clientMessageId":"c1","body":"hello"}),
    ] {
        assert!(serde_json::from_value::<StepInput>(input).is_err());
    }
    assert!(
        serde_json::from_value::<StepInput>(json!({
            "type":"event","connection":1,"subscription":-1,
            "event":{"type":"subscribed","channel_id":Uuid::nil(),"caught_up_seq":0}
        }))
        .is_ok()
    );
}

#[test]
fn accessors_and_shared_handles_support_incremental_controller_caches() -> Result<(), Box<dyn Error>>
{
    let channel = Uuid::from_u128(1);
    let mut core = Core::new(Uuid::from_u128(2));
    core.step(serde_json::from_value(
        json!({"type":"session_start","selfId":Uuid::from_u128(2)}),
    )?);
    let watched = core.step(serde_json::from_value(
        json!({"type":"watch","channel":channel}),
    )?);
    assert_eq!(watched.changed_channels, [channel]);
    let before = core.channel(channel).ok_or("missing Channel")?.clone();
    assert!(
        core.request(before.latest.ok_or("missing latest")?)
            .is_some()
    );
    let sent = core.step(serde_json::from_value(json!({
        "type":"user_send","channel":channel,"clientMessageId":Uuid::from_u128(3),"body":"hello"
    }))?);
    assert!(sent.state_changed);
    assert_eq!(sent.changed_channels, [channel]);
    let after = core.channel(channel).ok_or("missing Channel")?;
    assert!(Rc::ptr_eq(&before.messages, &after.messages));
    assert!(!Rc::ptr_eq(&before.pending, &after.pending));
    assert!(core.has_pending());
    assert!(core.request(after.pending[0].request).is_some());
    assert!(core.timer(999).is_none());
    let duplicate = core.step(serde_json::from_value(json!({
        "type":"user_send","channel":channel,"clientMessageId":Uuid::from_u128(3),"body":"hello"
    }))?);
    assert!(!duplicate.state_changed);
    assert!(duplicate.changed_channels.is_empty());
    Ok(())
}
