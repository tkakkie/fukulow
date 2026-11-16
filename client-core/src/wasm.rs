//! Thin value boundary: State stays in Core; only changed Channel views cross.
use crate::*;
use serde_json::{Value, json};
use std::rc::Rc;
use wasm_bindgen::prelude::*;

fn error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
#[wasm_bindgen]
pub struct WasmCore {
    core: Core,
    // Previous shared view handles let the next delta omit unchanged arrays.
    views: BTreeMap<Uuid, ChannelView>,
}
#[wasm_bindgen]
impl WasmCore {
    #[wasm_bindgen(constructor)]
    pub fn new(self_id: &str) -> Result<WasmCore, JsValue> {
        Ok(Self {
            core: Core::new(Uuid::parse_str(self_id).map_err(error)?),
            views: BTreeMap::new(),
        })
    }
    pub fn session(&self) -> Result<String, JsValue> {
        serde_json::to_string(self.core.session()).map_err(error)
    }
    pub fn request(&self, id: f64) -> Result<String, JsValue> {
        serde_json::to_string(&self.core.request(id as i64)).map_err(error)
    }
    pub fn timer(&self, id: f64) -> Result<String, JsValue> {
        serde_json::to_string(&self.core.timer(id as i64)).map_err(error)
    }
    #[wasm_bindgen(js_name = hasPending)]
    pub fn has_pending(&self) -> bool {
        self.core.has_pending()
    }
    pub fn step(&mut self, input: &str) -> Result<String, JsValue> {
        let input: StepInput = serde_json::from_str(input).map_err(error)?;
        serde_json::to_string(&self.output(input).map_err(error)?).map_err(error)
    }
}
impl WasmCore {
    fn output(&mut self, input: StepInput) -> Result<Value, serde_json::Error> {
        let result = self.core.step(input);
        let mut channels = serde_json::Map::new();
        for id in &result.changed_channels {
            if let Some(channel) = self.core.channel(*id) {
                let before = self.views.get(id);
                let mut metadata = channel.clone();
                metadata.messages = Rc::default();
                metadata.pending = Rc::default();
                metadata.advancing = Rc::default();
                let mut patch = serde_json::to_value(&metadata)?;
                if before.is_none_or(|c| !Rc::ptr_eq(&c.messages, &channel.messages)) {
                    let prior: BTreeMap<_, _> = before
                        .into_iter()
                        .flat_map(|c| {
                            c.messages
                                .iter()
                                .enumerate()
                                .map(|(index, message)| (Rc::as_ptr(message), index))
                        })
                        .collect();
                    patch["messages"] = Value::Array(
                        channel
                            .messages
                            .iter()
                            .map(|message| {
                                prior.get(&Rc::as_ptr(message)).map_or_else(
                                    || serde_json::to_value(message),
                                    |index| Ok(json!(index)),
                                )
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                    );
                } else if let Value::Object(fields) = &mut patch {
                    fields.remove("messages");
                }
                if before.is_none_or(|c| !Rc::ptr_eq(&c.pending, &channel.pending)) {
                    let prior: BTreeMap<_, _> = before
                        .into_iter()
                        .flat_map(|c| {
                            c.pending.iter().enumerate().map(|(index, pending)| {
                                (pending.client_message_id, (index, pending))
                            })
                        })
                        .collect();
                    patch["pending"] = Value::Array(
                        channel
                            .pending
                            .iter()
                            .map(|pending| match prior.get(&pending.client_message_id) {
                                Some((index, previous)) if *previous == pending => Ok(json!(index)),
                                _ => serde_json::to_value(pending),
                            })
                            .collect::<Result<Vec<_>, _>>()?,
                    );
                } else if let Value::Object(fields) = &mut patch {
                    fields.remove("pending");
                }
                if before.is_none_or(|c| !Rc::ptr_eq(&c.advancing, &channel.advancing)) {
                    patch["advancing"] = serde_json::to_value(&channel.advancing)?;
                } else if let Value::Object(fields) = &mut patch {
                    fields.remove("advancing");
                }
                self.views.insert(*id, channel.clone());
                channels.insert(id.to_string(), patch);
            } else {
                self.views.remove(id);
                channels.insert(id.to_string(), Value::Null);
            }
        }
        let mut out = serde_json::to_value(&result)?;
        out["channels"] = Value::Object(channels);
        out["session"] = serde_json::to_value(self.core.session())?;
        // A body may occur in records, a changed view and a send effect. Ship its
        // text once, including pending sends; JS expands only those bounded views.
        let mut bodies = Vec::new();
        intern_bodies(&mut out, &mut bodies);
        out["bodies"] = json!(bodies);
        Ok(out)
    }
}
fn intern_bodies(value: &mut Value, bodies: &mut Vec<String>) {
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if key == "body"
                    && let Some(body) = value.as_str()
                {
                    let index = bodies
                        .iter()
                        .position(|text| text == body)
                        .unwrap_or_else(|| {
                            bodies.push(body.to_owned());
                            bodies.len() - 1
                        });
                    *value = json!(index);
                } else {
                    intern_bodies(value, bodies);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| intern_bodies(v, bodies)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    #[test]
    fn deltas_omit_unchanged_arrays_reuse_messages_and_intern_bodies_once()
    -> Result<(), Box<dyn Error>> {
        let id = Uuid::from_u128(1);
        let mut binding = WasmCore {
            core: Core::new(id),
            views: BTreeMap::new(),
        };
        let mut step = |input| binding.output(serde_json::from_value(input)?);
        step(json!({"type":"session_start", "selfId":id}))?;
        step(json!({"type":"connection_ready", "connection":1}))?;
        step(json!({"type":"watch", "channel":id}))?;
        let message = |seq| {
            json!({"id":Uuid::from_u128(seq), "channel_id":id, "seq":seq,
            "sender":id,"client_message_id":Uuid::from_u128(seq), "body":"one body",
            "created_at":"2026-01-01T00:00:00Z", "topic_id":null, "reply_to":null, "reply_root_id":null, "mentions":[]})
        };
        let history = step(
            json!({"type":"history_result", "request":3, "page":{"messages":[message(1)], "has_more":false}}),
        )?;
        assert_eq!(history["bodies"], json!(["one body"]));
        assert_eq!(
            serde_json::to_string(&history)?.matches("one body").count(),
            1
        );
        assert!(history.get("requests").is_none());
        assert!(history.get("timers").is_none());
        let confirmed = step(
            json!({"type":"event", "connection":1, "event":{"type":"subscribed", "channel_id":id,"caught_up_seq":1}}),
        )?;
        assert!(
            confirmed["channels"][id.to_string()]
                .get("messages")
                .is_none()
        );
        let appended = step(
            json!({"type":"event", "connection":1, "event":{"type":"message", "message":message(2)}}),
        )?;
        assert_eq!(appended["channels"][id.to_string()]["messages"][0], 0);
        assert_eq!(appended["bodies"], json!(["one body"]));
        let pending = step(
            json!({"type":"user_send", "channel":id, "clientMessageId":Uuid::from_u128(3), "body":"pending body"}),
        )?;
        assert!(
            pending["channels"][id.to_string()]
                .get("messages")
                .is_none()
        );
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
        assert!(binding.views.is_empty());
        Ok(())
    }
}
