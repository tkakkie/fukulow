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
            "event":{"history_generation":Uuid::nil(),"type":"subscribed","channel_id":Uuid::nil(),"caught_up_seq":0}
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

#[test]
fn event_page_records_replace_each_identity_in_native_output() -> Result<(), Box<dyn Error>> {
    let channel = Uuid::from_u128(1);
    let self_id = Uuid::from_u128(2);
    let mut core = Core::new(self_id);
    let mut feed = |value| core.step(serde_json::from_value::<StepInput>(value).unwrap());
    let message = |seq, version| {
        json!({"history_generation":Uuid::nil(),"id":Uuid::from_u128(seq), "channel_id":channel,
        "created_seq":seq, "version":version, "deleted":false, "client_message_id":Uuid::from_u128(seq + 1000),
        "sender":Uuid::from_u128(3), "body":"body", "created_at":"2026-01-01T00:00:00Z", "topic_id":null, "reply_to":null,"reply_root_id":null,"mentions":[]})
    };
    feed(json!({"type":"session_start","selfId":self_id}));
    feed(json!({"type":"connection_ready","connection":1}));
    let watched = feed(json!({"type":"watch","channel":channel}));
    let history = watched
        .effects
        .iter()
        .find_map(|e| {
            if let fukulow_client_core::Effect::FetchHistory { id, .. } = e {
                Some(*id)
            } else {
                None
            }
        })
        .ok_or("missing history")?;
    feed(
        json!({"type":"history_result","request":history,"page":{"history_generation":Uuid::nil(),"as_of_seq":100,"messages":[message(100,100)],"has_more":false}}),
    );
    let subscribed = feed(
        json!({"type":"event","connection":1,"event":{"history_generation":Uuid::nil(),"type":"subscribed","channel_id":channel,"caught_up_seq":102}}),
    );
    let fill = subscribed
        .effects
        .iter()
        .find_map(|e| {
            if let fukulow_client_core::Effect::FetchHistory { id, .. } = e {
                Some(*id)
            } else {
                None
            }
        })
        .ok_or("missing fill")?;
    let result = feed(
        json!({"type":"events_result","request":fill,"page":{"history_generation":Uuid::nil(),"events":[
        {"type":"message","seq":101,"kind":"edit","message":message(1,101)},
        {"type":"message","seq":102,"kind":"edit","message":message(1,102)}],"has_more":false}}),
    );
    assert_eq!(result.records.len(), 1);
    assert_eq!(result.records[0].0, channel);
    assert_eq!(result.records[0].1.len(), 1);
    assert_eq!(result.records[0].1[0].version, 102);
    assert_eq!(
        core.channel(channel).ok_or("missing Channel")?.cursor,
        Some(102)
    );
    Ok(())
}
