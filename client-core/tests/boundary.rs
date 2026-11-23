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

#[test]
fn move_positions_advance_live_replay_and_gap_fill_without_creating_state() {
    use fukulow_client_core::{Effect, Page};

    let channel = Uuid::from_u128(1);
    let self_id = Uuid::from_u128(2);
    let generation = Uuid::nil();
    let message = |seq| {
        json!({
            "history_generation":generation,"id":Uuid::from_u128(seq),"channel_id":channel,
            "created_seq":seq,"version":seq,"deleted":false,"client_message_id":Uuid::from_u128(seq+1000),
            "sender":self_id,"body":"body","created_at":"2026-01-01T00:00:00Z","topic_id":null,
            "reply_to":null,"reply_root_id":null,"mentions":[]
        })
    };
    let moved = json!({
        "type":"message","kind":"move","seq":101,"version":101,"channel_id":channel,
        "history_generation":generation,"root_id":Uuid::from_u128(100),"source_topic_id":null,
        "destination_topic_id":Uuid::from_u128(9),"operation_id":Uuid::from_u128(10)
    });
    let following = json!({"type":"message","kind":"create","seq":102,"message":message(102)});
    let event = |connection, event| json!({"type":"event","connection":connection,"event":event});
    let subscribed = |connection, position| {
        event(
            connection,
            json!({
                "type":"subscribed","channel_id":channel,"history_generation":generation,"caught_up_seq":position,
            }),
        )
    };
    let request = |effects: &[Effect], expected: Page| {
        effects
            .iter()
            .find_map(|effect| match effect {
                Effect::FetchHistory { id, page, .. } if *page == expected => Some(*id),
                _ => None,
            })
            .unwrap()
    };

    for mode in ["live", "replay", "fill"] {
        let mut core = Core::new(self_id);
        let feed = |core: &mut Core, input| core.step(serde_json::from_value(input).unwrap());
        feed(&mut core, json!({"type":"session_start","selfId":self_id}));
        feed(&mut core, json!({"type":"connection_ready","connection":1}));
        let watched = feed(&mut core, json!({"type":"watch","channel":channel}));
        feed(
            &mut core,
            json!({"type":"history_result","request":request(&watched.effects,Page::Latest),
            "page":{"history_generation":generation,"as_of_seq":100,"messages":[message(100)],"has_more":false}}),
        );
        feed(
            &mut core,
            subscribed(1, if mode == "fill" { 102 } else { 100 }),
        );
        let connection = if mode == "replay" {
            let closed = feed(
                &mut core,
                json!({"type":"socket_closed","connection":1,"code":1006}),
            );
            let timer = closed
                .effects
                .iter()
                .find_map(|effect| match effect {
                    Effect::Wait {
                        id,
                        purpose: fukulow_client_core::Purpose::ReconnectBackoff,
                        ..
                    } => Some(*id),
                    _ => None,
                })
                .unwrap();
            let connecting = feed(&mut core, json!({"type":"timer_elapsed","id":timer}));
            let connection = connecting
                .effects
                .iter()
                .find_map(|effect| match effect {
                    Effect::Connect { id } => Some(*id),
                    _ => None,
                })
                .unwrap();
            let ready = feed(
                &mut core,
                json!({"type":"connection_ready","connection":connection}),
            );
            assert!(
                ready
                    .effects
                    .iter()
                    .any(|effect| matches!(effect, Effect::Subscribe { after_seq: 100, .. }))
            );
            assert!(
                feed(&mut core, event(1, moved.clone()))
                    .changed_channels
                    .is_empty()
            );
            connection
        } else {
            1
        };
        let result = if mode == "fill" {
            let fill = core.channel(channel).unwrap().fill.unwrap();
            feed(&mut core, event(connection, following.clone()));
            assert_eq!(core.channel(channel).unwrap().cursor, Some(100));
            feed(
                &mut core,
                json!({"type":"events_result","request":fill,
                "page":{"history_generation":generation,"events":[moved.clone()],"has_more":false}}),
            )
        } else {
            feed(&mut core, event(connection, moved.clone()))
        };
        assert!(result.records.is_empty(), "{mode}");
        assert!(
            !result.effects.iter().any(|effect| matches!(
                effect,
                Effect::FetchHistory {
                    page: Page::After,
                    ..
                }
            )),
            "{mode}"
        );
        let latest = request(&result.effects, Page::Latest);
        let state = core.channel(channel).unwrap();
        assert_eq!(state.move_seq, Some(101));
        assert_eq!(state.mutation_seq, 101);
        assert!(state.messages.iter().all(|m| m.created_seq == 102));
        assert_eq!(state.cursor, Some(if mode == "fill" { 102 } else { 101 }));
        if mode != "fill" {
            feed(&mut core, event(connection, following.clone()));
            if mode == "replay" {
                feed(&mut core, subscribed(connection, 102));
            }
        }
        let duplicate = feed(&mut core, event(connection, moved.clone()));
        assert!(duplicate.effects.is_empty(), "{mode}");
        let state = core.channel(channel).unwrap();
        assert_eq!(state.cursor, Some(102), "{mode}");
        assert_eq!(state.messages.len(), 1, "{mode}");
        assert_eq!(state.messages[0].created_seq, 102, "{mode}");

        let mut canonical = message(100);
        canonical["topic_id"] = json!(Uuid::from_u128(9));
        canonical["version"] = json!(101);
        feed(
            &mut core,
            json!({"type":"history_result","request":latest,"page":{
                "history_generation":generation,"as_of_seq":102,"messages":[canonical, message(102)],"has_more":false
            }}),
        );
        let state = core.channel(channel).unwrap();
        assert_eq!(state.messages[0].version, 101, "{mode}");
        assert_eq!(
            state.messages[0].topic_id,
            Some(Uuid::from_u128(9)),
            "{mode}"
        );
        assert_eq!(state.messages[1].created_seq, 102, "{mode}");
    }
}

#[test]
fn move_epochs_increase_across_channel_resets_and_are_shared_across_channels() {
    let channel = Uuid::from_u128(1);
    let other_channel = Uuid::from_u128(5);
    let self_id = Uuid::from_u128(2);
    let first_generation = Uuid::from_u128(3);
    let next_generation = Uuid::from_u128(4);
    let mut core = Core::new(self_id);
    let feed = |core: &mut Core, value| core.step(serde_json::from_value(value).unwrap());
    feed(&mut core, json!({"type":"session_start","selfId":self_id}));

    let mut previous_epoch = 0;
    for (channel, generation) in [
        (channel, first_generation),
        (channel, next_generation),
        (other_channel, next_generation),
    ] {
        feed(
            &mut core,
            json!({"type":"history_generation","generation":generation}),
        );
        let connection = core.session().connection.unwrap();
        feed(
            &mut core,
            json!({"type":"connection_ready","connection":connection}),
        );
        feed(&mut core, json!({"type":"watch","channel":channel}));
        let state = core.channel(channel).unwrap();
        assert_eq!(state.move_epoch, None);
        let latest = state.latest.unwrap();
        feed(
            &mut core,
            json!({"type":"history_result","request":latest,
            "page":{"history_generation":generation,"as_of_seq":100,"messages":[],"has_more":false}}),
        );
        feed(
            &mut core,
            json!({"type":"event","connection":connection,"event":{
                "type":"message","kind":"move","seq":101,"version":101,"channel_id":channel,
                "history_generation":generation,"root_id":Uuid::from_u128(100),"source_topic_id":null,
                "destination_topic_id":Uuid::from_u128(9),"operation_id":Uuid::from_u128(10)
            }}),
        );
        let state = core.channel(channel).unwrap();
        assert_eq!(state.move_seq, Some(101));
        let epoch = state.move_epoch.unwrap();
        assert!(
            epoch > previous_epoch,
            "Move epoch {epoch} reused after {previous_epoch}"
        );
        previous_epoch = epoch;
    }
    let first = core.channel(channel).unwrap().move_epoch.unwrap();
    let other = core.channel(other_channel).unwrap().move_epoch.unwrap();
    assert!(first < other);
}

#[test]
fn a_new_move_is_reported_once_in_step_moves() {
    use fukulow_client_core::{Effect, Page};

    let channel = Uuid::from_u128(1);
    let self_id = Uuid::from_u128(2);
    let generation = Uuid::nil();
    let root = Uuid::from_u128(100);
    let mut core = Core::new(self_id);
    let mut feed = |input: serde_json::Value| core.step(serde_json::from_value(input).unwrap());
    feed(json!({"type":"session_start","selfId":self_id}));
    feed(json!({"type":"connection_ready","connection":1}));
    let watched = feed(json!({"type":"watch","channel":channel}));
    let latest = watched
        .effects
        .iter()
        .find_map(|effect| match effect {
            Effect::FetchHistory {
                id,
                page: Page::Latest,
                ..
            } => Some(*id),
            _ => None,
        })
        .unwrap();
    let message = json!({
        "history_generation":generation,"id":root,"channel_id":channel,
        "created_seq":100,"version":100,"deleted":false,"client_message_id":Uuid::from_u128(1100),
        "sender":self_id,"body":"body","created_at":"2026-01-01T00:00:00Z","topic_id":null,
        "reply_to":null,"reply_root_id":null,"mentions":[]
    });
    let settled = feed(json!({"type":"history_result","request":latest,
        "page":{"history_generation":generation,"as_of_seq":100,"messages":[message],"has_more":false}}));
    assert!(settled.moves.is_empty());
    feed(json!({"type":"event","connection":1,"event":{
        "type":"subscribed","channel_id":channel,"history_generation":generation,"caught_up_seq":100}}));
    let moved = json!({"type":"event","connection":1,"event":{
        "type":"message","kind":"move","seq":101,"version":101,"channel_id":channel,
        "history_generation":generation,"root_id":root,"source_topic_id":null,
        "destination_topic_id":Uuid::from_u128(9),"operation_id":Uuid::from_u128(10)}});
    let first = feed(moved.clone());
    assert_eq!(first.moves.len(), 1);
    assert_eq!(
        (
            first.moves[0].channel_id,
            first.moves[0].root_id,
            first.moves[0].version
        ),
        (channel, root, 101)
    );
    let serialized = serde_json::to_value(&first).unwrap();
    assert_eq!(serialized["moves"][0]["root_id"], json!(root));
    let again = feed(moved);
    assert!(again.moves.is_empty());
    assert!(serde_json::to_value(&again).unwrap().get("moves").is_none());
}
