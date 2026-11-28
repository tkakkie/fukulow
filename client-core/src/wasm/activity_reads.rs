//! Numeric Wasm boundary for the activity read scheduler.
use crate::activity_reads::{ActivityReads, Effect, Failure, Input, Read, ReadReason};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmActivityReads(ActivityReads);

#[wasm_bindgen]
pub enum ActivityReadInputCode {
    Invalidate,
    Demand,
    DemandCoverage,
    Ready,
    ReadyReplacement,
    Fence,
    Ensure,
    Refresh,
    FlushQueued,
    RetryNow,
    Run,
    Start,
    Deadline,
    ReadCompleted,
    Success,
    Coverage,
    Accept,
    AfterAccept,
    Failure,
    CheckTerminal,
    RetryFailure,
    RetryDelay,
    Stop,
    Suspend,
    Close,
}

#[wasm_bindgen]
pub enum ActivityReadEffectCode {
    Run,
    Join,
    CheckCanLoad,
    Start,
    Schedule,
    CancelTimer,
    Abort,
    Hide,
    InvalidateForReady,
    ReadyCovered,
    ClearFailure,
    Finish,
    CheckCoverage,
    PrepareAccept,
    Accept,
    Error,
    CheckTerminal,
    Backoff,
    Return,
    ReturnIfCurrent,
}

#[wasm_bindgen]
impl WasmActivityReads {
    #[wasm_bindgen(constructor)]
    pub fn new(manual_retry: bool, retry_queued_terminal: bool, accept_below_floor: bool) -> Self {
        Self(ActivityReads::new(
            manual_retry,
            retry_queued_terminal,
            accept_below_floor,
        ))
    }

    pub fn step(
        &mut self,
        code: ActivityReadInputCode,
        now: f64,
        fields: &[f64],
    ) -> Result<Vec<f64>, JsValue> {
        let input =
            decode(code, fields).ok_or_else(|| JsValue::from_str("Invalid activity read input"))?;
        let mut encoded = Vec::new();
        for effect in self.0.step(input, now) {
            encode(effect, &mut encoded);
        }
        Ok(encoded)
    }

    #[wasm_bindgen(js_name = isCurrent)]
    pub fn is_current(&self, generation: f64) -> bool {
        self.0.is_current(generation as u64)
    }

    #[wasm_bindgen(js_name = inFlight)]
    pub fn in_flight(&self) -> bool {
        self.0.in_flight()
    }

    pub fn idle(&self) -> bool {
        self.0.idle()
    }

    #[wasm_bindgen(js_name = pendingNotice)]
    pub fn pending_notice(&self) -> bool {
        self.0.pending_notice()
    }
}

// Reason codes match the ordered table in activity-reads-wasm.ts.
const REASONS: [ReadReason; 5] = [
    ReadReason::Initial,
    ReadReason::Notice,
    ReadReason::Access,
    ReadReason::Reconcile,
    ReadReason::Periodic,
];

fn reason(code: f64) -> Option<ReadReason> {
    let index = code as usize;
    (code == index as f64)
        .then(|| REASONS.get(index).copied())
        .flatten()
}

fn reasons(fields: &[f64]) -> Option<Vec<ReadReason>> {
    fields.iter().copied().map(reason).collect()
}

// Optional numbers use NaN as the absent marker.
fn optional(value: f64) -> Option<f64> {
    (!value.is_nan()).then_some(value)
}

fn read(generation: f64, epoch: f64) -> Read {
    Read {
        generation: generation as u64,
        epoch: optional(epoch),
    }
}

fn decode(code: ActivityReadInputCode, fields: &[f64]) -> Option<Input> {
    use ActivityReadInputCode as Code;
    Some(match (code, fields) {
        (Code::Invalidate, &[kind, delay]) => Input::Invalidate {
            reason: reason(kind)?,
            delay,
        },
        (Code::Demand, &[delay]) => Input::Demand { delay },
        (Code::DemandCoverage, []) => Input::DemandCoverage,
        (Code::Ready, &[epoch]) => Input::Ready {
            epoch: optional(epoch),
        },
        (Code::ReadyReplacement, []) => Input::ReadyReplacement,
        (Code::Fence, []) => Input::Fence,
        (Code::Ensure, []) => Input::Ensure,
        (Code::Refresh, &[kind]) => Input::Refresh {
            reason: reason(kind)?,
        },
        (Code::FlushQueued, []) => Input::FlushQueued,
        (Code::RetryNow, []) => Input::RetryNow,
        (Code::Run, []) => Input::Run,
        (Code::Start, &[epoch]) => Input::Start {
            epoch: optional(epoch),
        },
        (Code::Deadline, &[generation]) => Input::Deadline {
            generation: generation as u64,
        },
        (Code::ReadCompleted, &[cancelled]) => Input::ReadCompleted {
            cancelled: cancelled != 0.0,
        },
        (Code::Success, &[generation, epoch, notice, ref demand @ ..]) => Input::Success {
            read: read(generation, epoch),
            serving_notice: notice != 0.0,
            reasons: reasons(demand)?,
        },
        (Code::Coverage, &[notice, covered, ref demand @ ..]) => Input::Coverage {
            serving_notice: notice != 0.0,
            covered: covered != 0.0,
            reasons: reasons(demand)?,
        },
        (Code::Accept, &[generation, epoch, covered]) => Input::Accept {
            read: read(generation, epoch),
            covered: covered != 0.0,
        },
        (Code::AfterAccept, &[covered]) => Input::AfterAccept {
            covered: covered != 0.0,
        },
        (Code::Failure, &[generation, epoch]) => Input::Failure {
            read: read(generation, epoch),
        },
        (Code::CheckTerminal, &[generation, epoch]) => Input::CheckTerminal {
            read: read(generation, epoch),
        },
        (
            Code::RetryFailure,
            &[
                generation,
                epoch,
                notice,
                network,
                status,
                retry_after,
                ref demand @ ..,
            ],
        ) => Input::RetryFailure {
            read: read(generation, epoch),
            serving_notice: notice != 0.0,
            reasons: reasons(demand)?,
            failure: Failure {
                network: network != 0.0,
                status: optional(status),
                retry_after: optional(retry_after),
            },
        },
        (Code::RetryDelay, &[cap, retry_after, draw]) => Input::RetryDelay {
            cap,
            retry_after,
            draw,
        },
        (Code::Stop, []) => Input::Stop,
        (Code::Suspend, []) => Input::Suspend,
        (Code::Close, []) => Input::Close,
        _ => return None,
    })
}

fn encode(effect: Effect, encoded: &mut Vec<f64>) {
    use ActivityReadEffectCode as Code;
    let code = match effect {
        Effect::Run => Code::Run,
        Effect::Join => Code::Join,
        Effect::CheckCanLoad => Code::CheckCanLoad,
        Effect::Start { read, reasons } => {
            encoded.extend_from_slice(&[
                Code::Start as u32 as f64,
                read.generation as f64,
                read.epoch.unwrap_or(f64::NAN),
                reasons.len() as f64,
            ]);
            encoded.extend(reasons.into_iter().map(|reason| reason as u32 as f64));
            return;
        }
        Effect::Schedule { generation, delay } => {
            encoded.extend_from_slice(&[Code::Schedule as u32 as f64, generation as f64, delay]);
            return;
        }
        Effect::CancelTimer => Code::CancelTimer,
        Effect::Abort => Code::Abort,
        Effect::Hide { reason, demand } => {
            encoded.extend_from_slice(&[
                Code::Hide as u32 as f64,
                reason as u32 as f64,
                demand.unwrap_or(f64::NAN),
            ]);
            return;
        }
        Effect::InvalidateForReady => Code::InvalidateForReady,
        Effect::ReadyCovered => Code::ReadyCovered,
        Effect::ClearFailure => Code::ClearFailure,
        Effect::Finish { serving_notice } => {
            encoded.extend_from_slice(&[Code::Finish as u32 as f64, f64::from(serving_notice)]);
            return;
        }
        Effect::CheckCoverage => Code::CheckCoverage,
        Effect::PrepareAccept { covered } => {
            encoded.extend_from_slice(&[Code::PrepareAccept as u32 as f64, f64::from(covered)]);
            return;
        }
        Effect::Accept { covered } => {
            encoded.extend_from_slice(&[Code::Accept as u32 as f64, f64::from(covered)]);
            return;
        }
        Effect::Error => Code::Error,
        Effect::CheckTerminal => Code::CheckTerminal,
        Effect::Backoff { cap, retry_after } => {
            encoded.extend_from_slice(&[Code::Backoff as u32 as f64, cap, retry_after]);
            return;
        }
        Effect::Return => Code::Return,
        Effect::ReturnIfCurrent => Code::ReturnIfCurrent,
    };
    encoded.push(code as u32 as f64);
}
