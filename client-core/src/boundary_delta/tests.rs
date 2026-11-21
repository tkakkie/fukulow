use super::*;
use serde_json::{Value, json};
use std::error::Error;

fn message(seq: usize, version: usize) -> Rc<Message> {
    let id = Uuid::from_u128(seq as u128);
    Rc::new(Message {
        history_generation: Uuid::nil(),
        id,
        channel_id: Uuid::nil(),
        created_seq: seq as i64,
        version: version as i64,
        deleted: false,
        client_message_id: id,
        sender: Uuid::nil(),
        body: Some("shared body".into()),
        created_at: "2026-01-01T00:00:00Z".into(),
        topic_id: None,
        reply_to: None,
        reply_root_id: None,
        mentions: None,
    })
}

#[test]
fn message_splices_trim_append_and_replace_at_each_window_size() {
    for limit in [
        MAIN_MESSAGE_LIMIT,
        TOPIC_MESSAGE_LIMIT,
        REPLY_MESSAGE_LIMIT,
        TOTAL_MESSAGE_LIMIT,
    ] {
        let old: Vec<_> = (1..=limit).map(|seq| message(seq, seq)).collect();
        let mid = limit / 2;
        let mut new = old[1..].to_vec();
        new[mid - 2] = message(mid, limit + 1);
        new.push(message(limit + 2, limit + 2));
        let mut bodies = Bodies::default();
        let ops = splices(&old, &new, &mut bodies);
        assert_eq!(
            ops.iter()
                .map(|op| (op.start, op.delete, op.insert.len()))
                .collect::<Vec<_>>(),
            [(0, 1, 0), (mid - 1, 1, 1), (limit, 0, 1)]
        );
        let mut applied: Vec<_> = old.iter().map(|m| (m.created_seq, m.version)).collect();
        for op in ops.into_iter().rev() {
            applied.splice(
                op.start..op.start + op.delete,
                op.insert.into_iter().map(|m| {
                    assert_eq!(m.body, Some(0));
                    (m.created_seq, m.version)
                }),
            );
        }
        assert_eq!(
            applied,
            new.iter()
                .map(|m| (m.created_seq, m.version))
                .collect::<Vec<_>>()
        );
        assert_eq!(bodies.text, ["shared body"]);
    }
}

#[test]
fn load_older_splices_prepend_and_trim_the_main_window_tail() -> serde_json::Result<()> {
    let id = Uuid::nil();
    let mut boundary = Boundary::new(id);
    let mut step = |input| -> serde_json::Result<Value> {
        serde_json::from_str(&boundary.step(serde_json::from_value(input)?)?)
    };
    let limit = MAIN_MESSAGE_LIMIT;
    let as_of = limit + 2;
    let page = |request: &Value, first, last, has_more| {
        json!({
            "type": "history_result", "request": request,
            "page": { "history_generation": id, "as_of_seq": as_of, "has_more": has_more,
                "messages": (first..=last).map(|seq| message(seq, seq)).collect::<Vec<_>>() }
        })
    };
    step(json!({"type":"session_start", "selfId":id}))?;
    step(json!({"type":"connection_ready", "connection":1}))?;
    let watch = step(json!({"type":"watch", "channel":id}))?;
    step(page(&watch["effects"][0]["id"], as_of - 199, as_of, true))?;
    let older = step(json!({"type":"load_older", "channel":id}))?;
    step(page(&older["effects"][0]["id"], 3, as_of - 200, true))?;
    let older = step(json!({"type":"load_older", "channel":id}))?;
    assert_eq!(older["effects"][0]["page"], "before");
    assert_eq!(older["effects"][0]["seq"], 3);
    let result = step(page(&older["effects"][0]["id"], 1, 2, false))?;
    let ops: Vec<_> = result["channels"][id.to_string()]["splices"]
        .as_array()
        .expect("Message window splices")
        .iter()
        .map(|op| {
            (
                op["start"].as_u64().expect("splice start") as usize,
                op["delete"].as_u64().expect("splice delete") as usize,
                op["insert"].as_array().expect("splice insert"),
            )
        })
        .collect();
    assert_eq!(
        ops.iter()
            .map(|(start, delete, insert)| (*start, *delete, insert.len()))
            .collect::<Vec<_>>(),
        [(0, 0, 2), (limit - 2, 2, 0)]
    );
    let mut applied: Vec<_> = (3..=as_of as u64).collect();
    for (start, delete, insert) in ops.into_iter().rev() {
        applied.splice(
            start..start + delete,
            insert
                .iter()
                .map(|m| m["created_seq"].as_u64().expect("creation position")),
        );
    }
    assert_eq!(applied, (1..=limit as u64).collect::<Vec<_>>());
    Ok(())
}

fn expand_interned_body(mut value: Value, bodies: &Bodies<'_>) -> Value {
    if let Some(body) = value.get_mut("body") {
        let index = body.as_u64().expect("interned body index") as usize;
        *body = json!(bodies.text[index]);
    }
    value
}

// Message, Pending and Send have no fields sent separately except body,
// which is stored in the per-step Bodies table and expanded for comparison.
#[test]
fn message_delta_matches_populated_message_and_tombstone() -> serde_json::Result<()> {
    let tombstone = Message {
        deleted: true,
        body: None,
        ..message(3, 4).as_ref().clone()
    };
    let populated = Message {
        history_generation: Uuid::from_u128(1),
        channel_id: Uuid::from_u128(2),
        client_message_id: Uuid::from_u128(5),
        sender: Uuid::from_u128(6),
        deleted: false,
        body: Some("Message body".into()),
        topic_id: Some(Uuid::from_u128(7)),
        reply_to: Some(Uuid::from_u128(8)),
        reply_root_id: Some(Uuid::from_u128(9)),
        mentions: Some(vec![Mention {
            member_id: Uuid::from_u128(10),
            name: "Mentioned Member".into(),
        }]),
        ..tombstone.clone()
    };
    let mut bodies = Bodies::default();
    for message in [&populated, &tombstone] {
        let delta = serde_json::to_value(MessageDelta::new(message, &mut bodies))?;
        assert_eq!(
            expand_interned_body(delta, &bodies),
            serde_json::to_value(message)?
        );
    }
    Ok(())
}

#[test]
fn pending_delta_matches_populated_and_minimal_pending() -> serde_json::Result<()> {
    let minimal = Pending {
        client_message_id: Uuid::from_u128(1),
        body: "Pending body".into(),
        state: PendingState::Sending,
        request: 2,
        retry_wait: None,
        failure_code: None,
        reply_to: None,
        topic_name: None,
        reply_root_id: None,
    };
    let populated = Pending {
        body: "Another Pending body".into(),
        state: PendingState::Throttled,
        retry_wait: Some(3),
        failure_code: Some("send_rate_limited".into()),
        reply_to: Some(Uuid::from_u128(4)),
        topic_name: Some("Topic".into()),
        reply_root_id: Some(Uuid::from_u128(5)),
        ..minimal.clone()
    };
    let mut bodies = Bodies::default();
    for pending in [&minimal, &populated] {
        let delta = serde_json::to_value(PendingDelta::new(pending, &mut bodies))?;
        assert_eq!(
            expand_interned_body(delta, &bodies),
            serde_json::to_value(pending)?
        );
    }
    Ok(())
}

#[test]
fn send_delta_matches_populated_and_minimal_send_effect() -> serde_json::Result<()> {
    for populated in [false, true] {
        let send = Effect::Send {
            history_generation: populated.then(|| Uuid::from_u128(1)),
            id: 2,
            channel: Uuid::from_u128(3),
            client_message_id: Uuid::from_u128(4),
            body: "Send body".into(),
            reply_to: populated.then(|| Uuid::from_u128(5)),
            topic_name: populated.then(|| "Topic".into()),
        };
        let mut bodies = Bodies::default();
        let delta = serde_json::to_value(EffectDelta::new(&send, &mut bodies))?;
        assert_eq!(
            expand_interned_body(delta, &bodies),
            serde_json::to_value(&send)?
        );
    }
    Ok(())
}

#[test]
fn step_delta_transmits_session_changes_and_channel_removal() -> Result<(), Box<dyn Error>> {
    let id = Uuid::from_u128(1);
    let mut boundary = Boundary::new(id);
    let mut step = |input| -> Result<Value, Box<dyn Error>> {
        Ok(serde_json::from_str(
            &boundary.step(serde_json::from_value(input)?)?,
        )?)
    };
    let started = step(json!({"type":"session_start", "selfId":id}))?;
    assert_eq!(started["session"]["running"], true);
    step(json!({"type":"watch", "channel":id}))?;
    let unchanged = step(json!({"type":"watch", "channel":id}))?;
    assert!(unchanged.get("session").is_none());
    let sent = step(
        json!({"type":"user_send", "channel":id, "clientMessageId":Uuid::from_u128(2), "body":"pending body"}),
    )?;
    assert_eq!(sent["bodies"], json!(["pending body"]));
    assert_eq!(sent["channels"][id.to_string()]["pending"][0]["body"], 0);
    let next = step(
        json!({"type":"user_send", "channel":id, "clientMessageId":Uuid::from_u128(3), "body":"pending body"}),
    )?;
    assert_eq!(next["channels"][id.to_string()]["pending"][0], 0);
    let stopped = step(json!({"type":"stop"}))?;
    assert_eq!(stopped["changedChannels"], json!([id]));
    assert_eq!(stopped["session"]["running"], false);
    assert_eq!(stopped["channels"].get(id.to_string()), Some(&Value::Null));
    assert!(boundary.previous.is_empty());
    Ok(())
}

#[test]
fn channel_patch_metadata_matches_the_channel_view() -> serde_json::Result<()> {
    // Enumerate every field so adding one requires checking how the patch sends it.
    let channel = ChannelView {
        state: Availability::Ready,
        watched: true,
        cursor: Some(1),
        snapshot_seq: Some(2),
        mutation_seq: 3,
        move_seq: Some(4),
        move_epoch: Some(5),
        moved_roots: Rc::default(),
        retired_move_through: 0,
        messages: Rc::new(vec![message(1, 1)]),
        versions: Rc::default(),
        retired_through: Some(6),
        retired_versions: Rc::default(),
        version_epoch: 7,
        advancing: Rc::default(),
        pending: Rc::default(),
        has_older: true,
        history_error: true,
        fill_attempt: 8,
        held_through: Some(9),
        forgotten_through: Some(10),
        last_used: Some(11),
        retained_count: Some(12),
        stream_base: Some(13),
        latest: Some(14),
        older: Some(15),
        fill: Some(16),
        wait: Some(17),
        subscription: Some(Rc::new(Subscription {
            id: 18,
            after: 19,
            confirmed: true,
            watermark: 20,
        })),
    };
    for view in [&channel, &ChannelView::default()] {
        let patch = ChannelPatch::new(Some(view), view, &mut Bodies::default());
        let mut expected = serde_json::to_value(view)?;
        let fields = expected
            .as_object_mut()
            .expect("ChannelView serializes as an object");
        for field in ["messages", "pending", "advancing"] {
            fields.remove(field);
        }
        assert_eq!(
            serde_json::to_value(patch)?,
            json!({ "metadata": expected })
        );
    }
    Ok(())
}

#[test]
fn deltas_omit_unchanged_arrays_reuse_messages_and_intern_bodies_once() -> Result<(), Box<dyn Error>>
{
    let id = Uuid::from_u128(1);
    let mut boundary = Boundary::new(id);
    let mut step = |input| -> serde_json::Result<Value> {
        serde_json::from_str(&boundary.step(serde_json::from_value(input)?)?)
    };
    step(json!({"type":"session_start", "selfId":id}))?;
    step(json!({"type":"connection_ready", "connection":1}))?;
    step(json!({"type":"watch", "channel":id}))?;
    let message = |seq| {
        json!({"history_generation":Uuid::nil(),"id":Uuid::from_u128(seq), "channel_id":id, "created_seq":seq,"version":seq,"deleted":false,
        "sender":id,"client_message_id":Uuid::from_u128(seq), "body":"one body",
        "created_at":"2026-01-01T00:00:00Z", "topic_id":null, "reply_to":null, "reply_root_id":null, "mentions":[]})
    };
    let history = step(
        json!({"type":"history_result", "request":3, "page":{"history_generation":Uuid::nil(),"as_of_seq":1,"messages":[message(1)], "has_more":false}}),
    )?;
    assert_eq!(history["bodies"], json!(["one body"]));
    assert_eq!(
        serde_json::to_string(&history)?.matches("one body").count(),
        1
    );
    assert!(history.get("requests").is_none());
    assert!(history.get("timers").is_none());
    let confirmed = step(
        json!({"type":"event", "connection":1, "event":{"history_generation":Uuid::nil(),"type":"subscribed", "channel_id":id,"caught_up_seq":1}}),
    )?;
    assert!(
        confirmed["channels"][id.to_string()]
            .get("splices")
            .is_none()
    );
    let appended = step(
        json!({"type":"event", "connection":1, "event":{"type":"message", "seq":2, "kind":"create", "message":message(2)}}),
    )?;
    let splices = &appended["channels"][id.to_string()]["splices"];
    assert_eq!(splices[0]["start"], 1);
    assert_eq!(splices[0]["delete"], 0);
    assert_eq!(splices[0]["insert"][0]["body"], 0);
    assert_eq!(appended["bodies"], json!(["one body"]));
    let pending = step(
        json!({"type":"user_send", "channel":id, "clientMessageId":Uuid::from_u128(3), "body":"pending body"}),
    )?;
    assert!(pending["channels"][id.to_string()].get("splices").is_none());
    assert_eq!(pending["bodies"], json!(["pending body"]));
    assert_eq!(
        serde_json::to_string(&pending)?
            .matches("pending body")
            .count(),
        1
    );
    let second = step(
        json!({"type":"user_send", "channel":id, "clientMessageId":Uuid::from_u128(4), "body":"second body"}),
    )?;
    assert_eq!(second["channels"][id.to_string()]["pending"][0], 0);
    assert_eq!(second["bodies"], json!(["second body"]));
    for _ in 0..2 {
        assert_eq!(step(json!({"type":"stop"}))?["stateChanged"], true);
    }
    assert!(boundary.previous.is_empty());
    Ok(())
}
