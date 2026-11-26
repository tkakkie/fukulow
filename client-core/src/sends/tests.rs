use crate::*;
use serde_json::{Value, json};
use std::rc::Rc;

fn feed(core: &mut Core, input: Value) -> StepResult {
    core.step(serde_json::from_value(input).unwrap())
}

#[test]
fn clamp_and_generation_reset_cancel_retry_waits_in_pending_order() {
    let self_id = Uuid::from_u128(1);
    let channel = Uuid::from_u128(2);
    let generation = Uuid::from_u128(3);
    for reset_generation in [false, true] {
        let mut core = Core::new(self_id);
        feed(&mut core, json!({"type":"session_start","selfId":self_id}));
        let connection = core.session().connection.unwrap();
        feed(
            &mut core,
            json!({"type":"connection_ready","connection":connection}),
        );
        feed(&mut core, json!({"type":"watch","channel":channel}));
        let history = core.channel(channel).unwrap().latest.unwrap();
        feed(
            &mut core,
            json!({"type":"history_result","request":history,"page":{
                "history_generation":generation,"as_of_seq":10,"messages":[],"has_more":false
            }}),
        );

        for key in 10..15 {
            feed(
                &mut core,
                json!({
                    "type":"user_send","channel":channel,"clientMessageId":Uuid::from_u128(key),
                    "body":key.to_string(),"topic_name":"Topic"
                }),
            );
        }
        let pending = core.channel(channel).unwrap().pending.clone();
        for (index, status) in [
            (1, json!(429)),
            (0, json!(429)),
            (3, json!("network")),
            (4, json!(400)),
        ] {
            feed(
                &mut core,
                json!({
                    "type":"send_failed","request":pending[index].request,"status":status
                }),
            );
        }
        let pending = core.channel(channel).unwrap().pending.clone();
        let first = pending[0].retry_wait.unwrap();
        let second = pending[1].retry_wait.unwrap();
        assert!(first > second);
        assert_eq!(pending[2].state, PendingState::Sending);
        assert_eq!(pending[3].state, PendingState::Unknown);
        assert_eq!(pending[4].state, PendingState::Failed);

        let result = if reset_generation {
            feed(
                &mut core,
                json!({"type":"history_generation","generation":Uuid::from_u128(4)}),
            )
        } else {
            feed(
                &mut core,
                json!({"type":"event","connection":connection,"event":{
                    "type":"subscribed","channel_id":channel,"history_generation":generation,
                    "caught_up_seq":5
                }}),
            )
        };
        let [
            Effect::Unsubscribe { .. },
            Effect::CancelTimer { id: a },
            Effect::CancelTimer { id: b },
            rest @ ..,
        ] = result.effects.as_slice()
        else {
            panic!("unexpected reset effects: {:?}", result.effects);
        };
        assert_eq!((*a, *b), (first, second));
        if reset_generation {
            assert!(matches!(
                rest,
                [
                    Effect::Connect { .. },
                    Effect::FetchHistory {
                        page: Page::Latest,
                        ..
                    }
                ]
            ));
        } else {
            assert!(matches!(
                rest,
                [Effect::FetchHistory {
                    page: Page::Latest,
                    ..
                }]
            ));
        }
        assert!(result.records.is_empty());
        assert_eq!(result.changed_channels, [channel]);
        assert!(result.state_changed);
        assert!(core.timer(first).is_none());
        assert!(core.timer(second).is_none());
        assert!(core.request(pending[2].request).unwrap().stale());

        let after = &core.channel(channel).unwrap().pending;
        let mut expected = (*pending).clone();
        for send in &mut expected[..3] {
            send.state = PendingState::Unknown;
            send.retry_wait = None;
        }
        assert_eq!(**after, expected);
        assert!(!Rc::ptr_eq(after, &pending));
    }
}
