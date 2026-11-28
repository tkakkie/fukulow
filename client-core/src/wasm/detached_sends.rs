//! Numeric Wasm boundary for detached draft restores.

use super::WasmCore;
use crate::detached_sends::{DetachedSends, Disposition, SendResult, can_restore_draft};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Default)]
pub struct WasmDetachedSends(DetachedSends);

#[wasm_bindgen]
pub enum DetachedSendDisposition {
    Keep,
    Drop,
    Restore,
}

#[wasm_bindgen]
impl WasmDetachedSends {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn track(&mut self, slot: f64) {
        self.0.track(slot as i64);
    }

    pub fn forget(&mut self, slot: f64) {
        self.0.forget(slot as i64);
    }

    pub fn attached(&self) -> Vec<f64> {
        self.0.attached().map(|slot| slot as f64).collect()
    }

    pub fn detach(&mut self, slot: f64) {
        self.0.detach(slot as i64);
    }

    pub fn reset(&mut self) -> Vec<f64> {
        self.0.reset().into_iter().map(|slot| slot as f64).collect()
    }

    pub fn observe(&mut self, slot: f64, ok: bool, status: Option<f64>) -> DetachedSendDisposition {
        let result = if ok {
            SendResult::Ack
        } else {
            status.map_or(SendResult::Network, SendResult::Http)
        };
        match self.0.observe(slot as i64, result) {
            Disposition::Keep => DetachedSendDisposition::Keep,
            Disposition::Drop => DetachedSendDisposition::Drop,
            Disposition::Restore => DetachedSendDisposition::Restore,
        }
    }

    #[wasm_bindgen(js_name = canRestoreDraft)]
    pub fn can_restore_draft(
        revision: f64,
        current_revision: f64,
        store_revision: Option<f64>,
        current_store_revision: Option<f64>,
        empty: bool,
    ) -> bool {
        can_restore_draft(
            revision,
            current_revision,
            store_revision,
            current_store_revision,
            empty,
        )
    }
}

#[wasm_bindgen]
impl WasmCore {
    #[wasm_bindgen(js_name = canDetachSend)]
    pub fn can_detach_send(&self, request: f64) -> bool {
        self.0.core.can_detach_send(request as i64)
    }
}
