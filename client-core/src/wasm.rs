//! Thin binding over the typed sync boundary.
use crate::{boundary_delta::Boundary, *};
use serde::{Deserialize, de::value::StrDeserializer};
use wasm_bindgen::prelude::*;

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
    #[wasm_bindgen(js_name = syncDelay)]
    pub fn sync_delay(purpose: &str, attempt: f64, draw_or_ms: f64) -> Result<f64, JsValue> {
        let purpose =
            Purpose::deserialize(StrDeserializer::<serde::de::value::Error>::new(purpose))
                .map_err(error)?;
        Ok(sync_delay(purpose, attempt as u64, draw_or_ms))
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
