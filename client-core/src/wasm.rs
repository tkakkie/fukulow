//! Thin binding over the typed sync boundary.
use crate::{boundary_delta::Boundary, *};
use serde::{Deserialize, de::value::StrDeserializer};
use wasm_bindgen::prelude::*;

mod activity_reads;
mod detached_sends;

#[wasm_bindgen]
#[derive(Default)]
pub struct WasmActivityRouting(activity_routing::ActivityRouting);

#[wasm_bindgen]
impl WasmActivityRouting {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn step(&mut self, input: &str, lifetime: &str) -> Result<String, JsValue> {
        let input = serde_json::from_str(input).map_err(error)?;
        let lifetime =
            AccessLifetime::deserialize(StrDeserializer::<serde::de::value::Error>::new(lifetime))
                .map_err(error)?;
        serde_json::to_string(&self.0.step(input, lifetime)).map_err(error)
    }

    pub fn delay(timing: &str, period: Option<f64>, draw: f64) -> Result<f64, JsValue> {
        let timing = activity_routing::ActivityDelay::deserialize(StrDeserializer::<
            serde::de::value::Error,
        >::new(timing))
        .map_err(error)?;
        Ok(activity_routing::activity_delay(timing, period, draw))
    }
}

fn error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub struct WasmCore(Boundary);

#[wasm_bindgen]
impl WasmCore {
    #[wasm_bindgen(constructor)]
    pub fn new(self_id: &str) -> Result<WasmCore, JsValue> {
        Ok(Self(Boundary::new(
            Uuid::parse_str(self_id).map_err(error)?,
        )))
    }
    pub fn session(&self) -> Result<String, JsValue> {
        serde_json::to_string(self.0.core.session()).map_err(error)
    }
    pub fn request(&self, id: f64) -> Result<String, JsValue> {
        serde_json::to_string(&self.0.core.request(id as i64)).map_err(error)
    }
    pub fn timer(&self, id: f64) -> Result<String, JsValue> {
        serde_json::to_string(&self.0.core.timer(id as i64)).map_err(error)
    }
    #[wasm_bindgen(js_name = historyIssue)]
    pub fn history_issue(&self) -> Option<f64> {
        self.0.core.history_issue().map(|issue| issue as f64)
    }
    #[wasm_bindgen(js_name = isGenerationConflict)]
    pub fn is_generation_conflict(status: Option<u16>, code: Option<String>) -> bool {
        history_generation::is_generation_conflict(status, code.as_deref())
    }
    #[wasm_bindgen(js_name = syncDelay)]
    pub fn sync_delay(purpose: &str, attempt: f64, draw_or_ms: f64) -> Result<f64, JsValue> {
        let purpose =
            Purpose::deserialize(StrDeserializer::<serde::de::value::Error>::new(purpose))
                .map_err(error)?;
        Ok(sync_delay(purpose, attempt as u64, draw_or_ms))
    }
    #[wasm_bindgen(js_name = accessOutcome)]
    pub fn access_outcome(
        endpoint: &str,
        lifetime: &str,
        status: Option<u16>,
        code: Option<String>,
    ) -> Result<String, JsValue> {
        let endpoint =
            AccessEndpoint::deserialize(StrDeserializer::<serde::de::value::Error>::new(endpoint))
                .map_err(error)?;
        let lifetime =
            AccessLifetime::deserialize(StrDeserializer::<serde::de::value::Error>::new(lifetime))
                .map_err(error)?;
        serde_json::to_string(&access_outcome(endpoint, lifetime, status, code.as_deref()))
            .map_err(error)
    }
    #[wasm_bindgen(js_name = hasPending)]
    pub fn has_pending(&self) -> bool {
        self.0.core.has_pending()
    }
    #[wasm_bindgen(js_name = subscribeIssued)]
    pub fn subscribe_issued(
        &mut self,
        connection: f64,
        channel: &str,
        id: f64,
    ) -> Result<(), JsValue> {
        self.0.core.subscribe_issued(
            connection as Token,
            Uuid::parse_str(channel).map_err(error)?,
            id as Token,
        );
        Ok(())
    }
    pub fn step(&mut self, input: &str) -> Result<String, JsValue> {
        let input = serde_json::from_str(input).map_err(error)?;
        self.0.step(input).map_err(error)
    }
}

#[wasm_bindgen]
#[derive(Default)]
pub struct WasmReplyCounts(crate::reply_counts::ReplyCounts);
#[wasm_bindgen]
impl WasmReplyCounts {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }
    pub fn step(&mut self, input: &str) -> Result<String, JsValue> {
        let input = serde_json::from_str(input).map_err(error)?;
        serde_json::to_string(&self.0.step(input)).map_err(error)
    }
}
