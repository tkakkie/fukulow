//! Scheduling policy for one held activity read target.
const DEBOUNCE_MS: f64 = 200.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadReason {
    Initial,
    Notice,
    Access,
    Reconcile,
    Periodic,
}

#[derive(Clone, Copy, Debug)]
pub struct Failure {
    pub network: bool,
    pub status: Option<f64>,
    pub retry_after: Option<f64>,
}

impl Failure {
    fn transient(self) -> bool {
        self.network
            || self
                .status
                .is_some_and(|status| status == 429.0 || status >= 500.0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Read {
    pub generation: u64,
    pub epoch: Option<f64>,
}

#[derive(Debug)]
pub enum Input {
    Invalidate {
        reason: ReadReason,
        delay: f64,
    },
    Demand {
        delay: f64,
    },
    DemandCoverage,
    Ready {
        epoch: Option<f64>,
    },
    ReadyReplacement,
    Fence,
    Ensure,
    Refresh {
        reason: ReadReason,
    },
    FlushQueued,
    RetryNow,
    Run,
    Start {
        epoch: Option<f64>,
    },
    Deadline {
        generation: u64,
    },
    ReadCompleted {
        cancelled: bool,
    },
    Success {
        read: Read,
        serving_notice: bool,
        reasons: Vec<ReadReason>,
    },
    Coverage {
        serving_notice: bool,
        reasons: Vec<ReadReason>,
        covered: bool,
    },
    Accept {
        read: Read,
        covered: bool,
    },
    AfterAccept {
        covered: bool,
    },
    Failure {
        read: Read,
    },
    CheckTerminal {
        read: Read,
    },
    RetryFailure {
        read: Read,
        serving_notice: bool,
        reasons: Vec<ReadReason>,
        failure: Failure,
    },
    RetryDelay {
        cap: f64,
        retry_after: f64,
        draw: f64,
    },
    Stop,
    Suspend,
    Close,
}

#[derive(Debug, PartialEq)]
pub enum Effect {
    Run,
    Join,
    CheckCanLoad,
    Start {
        read: Read,
        reasons: Vec<ReadReason>,
    },
    Schedule {
        generation: u64,
        delay: f64,
    },
    CancelTimer,
    Abort,
    Hide {
        reason: ReadReason,
        demand: Option<f64>,
    },
    InvalidateForReady,
    ReadyCovered,
    ClearFailure,
    Finish {
        serving_notice: bool,
    },
    CheckCoverage,
    PrepareAccept {
        covered: bool,
    },
    Accept {
        covered: bool,
    },
    Error,
    CheckTerminal,
    Backoff {
        cap: f64,
        retry_after: f64,
    },
    Return,
    ReturnIfCurrent,
}

#[derive(Default)]
pub struct ActivityReads {
    generation: u64,
    in_flight: Option<Read>,
    accepted_epoch: Option<f64>,
    ready_replacement: Option<u64>,
    pending_reasons: Vec<ReadReason>,
    due: Option<f64>,
    closed: bool,
    dirty: bool,
    queued: bool,
    retry: bool,
    stopped: bool,
    notice_pending: bool,
    serving_notice: bool,
    attempt: u32,
    below_floor: u32,
    manual_retry: bool,
    retry_queued_terminal: bool,
    accept_below_floor: bool,
}

impl ActivityReads {
    pub fn new(manual_retry: bool, retry_queued_terminal: bool, accept_below_floor: bool) -> Self {
        Self {
            manual_retry,
            retry_queued_terminal,
            accept_below_floor,
            ..Self::default()
        }
    }

    pub fn is_current(&self, generation: u64) -> bool {
        self.generation == generation
    }

    pub fn in_flight(&self) -> bool {
        self.in_flight.is_some()
    }

    pub fn idle(&self) -> bool {
        !self.closed && !self.in_flight() && !self.dirty && !self.retry && !self.stopped
    }

    pub fn pending_notice(&self) -> bool {
        !self.closed && (self.serving_notice || (self.notice_pending && self.dirty))
    }

    pub fn step(&mut self, input: Input, now: f64) -> Vec<Effect> {
        let mut effects = Vec::new();
        match input {
            Input::Invalidate { reason, delay } => {
                self.invalidate(reason, delay, now, &mut effects)
            }
            Input::Demand { delay } => self.demand(delay, now, &mut effects),
            Input::DemandCoverage => {
                if self.below_floor < 3 {
                    self.below_floor = 0;
                }
                if !self.in_flight() {
                    self.invalidate(ReadReason::Notice, DEBOUNCE_MS, now, &mut effects);
                }
            }
            Input::Ready { epoch } => self.ready(epoch, &mut effects),
            Input::ReadyReplacement => self.ready_replacement = Some(self.generation),
            Input::Fence => self.fence(now, &mut effects),
            Input::Ensure => {
                if self.in_flight() {
                    effects.push(Effect::Join);
                } else if !self.closed
                    && !self.stopped
                    && !self.dirty
                    && self.due.is_none()
                    && !self.retry
                {
                    if self.pending_reasons.is_empty() {
                        self.add_reason(ReadReason::Initial);
                    }
                    self.dirty = true;
                    effects.push(Effect::Run);
                }
            }
            Input::Refresh { reason } => {
                if !self.closed {
                    self.add_reason(reason);
                    self.stopped = false;
                    self.dirty = true;
                    if self.in_flight() {
                        self.queued = true;
                        effects.push(Effect::Join);
                    } else if !self.retry {
                        self.run_now(&mut effects);
                    }
                }
            }
            Input::FlushQueued => {
                if !self.closed {
                    if self.in_flight() {
                        effects.push(Effect::Join);
                    } else if self.dirty && !self.retry && self.due.is_some() {
                        self.run_now(&mut effects);
                    }
                }
            }
            Input::RetryNow => {
                self.retry = false;
                self.stopped = false;
                self.below_floor = 0;
                self.dirty = true;
                effects.push(Effect::ClearFailure);
                self.run_now(&mut effects);
            }
            Input::Run => {
                if !self.closed && self.dirty {
                    if self.in_flight() {
                        self.queued = true;
                    } else if !self.retry {
                        effects.push(Effect::CheckCanLoad);
                    }
                }
            }
            Input::Start { epoch } => {
                let read = Read {
                    epoch,
                    generation: self.generation,
                };
                self.in_flight = Some(read);
                self.queued = false;
                self.serving_notice = std::mem::take(&mut self.notice_pending);
                effects.push(Effect::ClearFailure);
                effects.push(Effect::Start {
                    read,
                    reasons: std::mem::take(&mut self.pending_reasons),
                });
            }
            Input::Deadline { generation } => {
                self.due = None;
                if !self.closed && self.is_current(generation) {
                    self.retry = false;
                    effects.push(Effect::Run);
                }
            }
            Input::ReadCompleted { cancelled } => {
                self.in_flight = None;
                let serving_notice = std::mem::take(&mut self.serving_notice);
                if !self.closed {
                    if cancelled {
                        if self.dirty {
                            self.schedule(0.0, now, &mut effects);
                        }
                    } else {
                        effects.push(Effect::Finish { serving_notice });
                    }
                }
            }
            Input::Success {
                read,
                serving_notice,
                reasons,
            } => {
                if self.is_current(read.generation) {
                    effects.push(Effect::CheckCoverage);
                } else {
                    self.replace_fenced(serving_notice, reasons, now, &mut effects);
                }
            }
            Input::Coverage {
                serving_notice,
                reasons,
                covered,
            } => {
                if covered {
                    self.dirty = self.queued;
                    self.attempt = 0;
                    self.below_floor = 0;
                } else {
                    self.restore_demand(serving_notice, reasons);
                    self.below_floor += 1;
                    if self.below_floor >= 3 {
                        self.backoff(0.0, &mut effects);
                    } else {
                        self.schedule(DEBOUNCE_MS, now, &mut effects);
                    }
                }
                if covered || self.accept_below_floor {
                    effects.push(Effect::PrepareAccept { covered });
                }
            }
            Input::Accept { read, covered } => {
                self.stopped = false;
                self.accepted_epoch = read.epoch;
                effects.push(Effect::ClearFailure);
                effects.push(Effect::Accept { covered });
            }
            Input::AfterAccept { covered } => {
                if covered && self.dirty {
                    self.schedule(DEBOUNCE_MS, now, &mut effects);
                }
            }
            Input::Failure { read } => {
                if self.is_current(read.generation) {
                    self.below_floor = 0;
                    self.accepted_epoch = None;
                    effects.push(Effect::Error);
                }
            }
            Input::CheckTerminal { read } => {
                if self.is_current(read.generation) {
                    effects.push(Effect::CheckTerminal);
                }
            }
            Input::RetryFailure {
                read,
                serving_notice,
                reasons,
                failure,
            } => {
                if self.manual_retry {
                    self.clear_demand();
                } else {
                    self.retry_failure(read, serving_notice, reasons, failure, now, &mut effects);
                }
            }
            Input::RetryDelay {
                cap,
                retry_after,
                draw,
            } => {
                self.schedule(
                    retry_after.max(cap / 2.0 + draw * cap / 2.0),
                    now,
                    &mut effects,
                );
            }
            Input::Stop => {
                self.stop();
                effects.push(Effect::Return);
            }
            Input::Suspend | Input::Close => {
                if matches!(input, Input::Close) {
                    self.closed = true;
                } else {
                    self.clear_demand();
                    self.retry = false;
                    self.below_floor = 0;
                }
                self.generation += 1;
                self.accepted_epoch = None;
                self.notice_pending = false;
                self.serving_notice = false;
                self.pending_reasons.clear();
                self.cancel_timer(&mut effects);
                effects.push(Effect::Abort);
            }
        }
        effects
    }

    fn add_reason(&mut self, reason: ReadReason) {
        if !self.pending_reasons.contains(&reason) {
            self.pending_reasons.push(reason);
        }
    }

    fn restore_demand(&mut self, serving_notice: bool, reasons: Vec<ReadReason>) {
        self.notice_pending |= serving_notice;
        for reason in reasons {
            self.add_reason(reason);
        }
    }

    fn clear_demand(&mut self) {
        self.dirty = false;
        self.queued = false;
        self.notice_pending = false;
        self.pending_reasons.clear();
    }

    fn stop(&mut self) {
        self.clear_demand();
        self.stopped = true;
    }

    fn schedule(&mut self, delay: f64, now: f64, effects: &mut Vec<Effect>) {
        if self.due.is_none() && !self.closed {
            self.due = Some(now + delay);
            effects.push(Effect::Schedule {
                generation: self.generation,
                delay,
            });
        }
    }

    fn cancel_timer(&mut self, effects: &mut Vec<Effect>) {
        if self.due.take().is_some() {
            effects.push(Effect::CancelTimer);
        }
    }

    fn run_now(&mut self, effects: &mut Vec<Effect>) {
        self.cancel_timer(effects);
        effects.push(Effect::Run);
    }

    fn backoff(&mut self, retry_after: f64, effects: &mut Vec<Effect>) {
        self.retry = true;
        let cap = f64::from((1000 << self.attempt.min(5)).min(30_000));
        self.attempt = self.attempt.saturating_add(1);
        effects.push(Effect::Backoff { cap, retry_after });
    }

    fn fence(&mut self, now: f64, effects: &mut Vec<Effect>) {
        self.generation += 1;
        self.accepted_epoch = None;
        if let Some(due) = self.due {
            self.cancel_timer(effects);
            self.schedule((due - now).max(0.0), now, effects);
        }
    }

    fn invalidate(&mut self, reason: ReadReason, delay: f64, now: f64, effects: &mut Vec<Effect>) {
        if self.closed {
            return;
        }
        self.add_reason(reason);
        if reason == ReadReason::Notice {
            self.notice_pending = true;
            self.demand(delay, now, effects);
        } else {
            self.fence(now, effects);
            effects.push(Effect::Hide {
                reason,
                demand: Some(delay),
            });
        }
    }

    fn demand(&mut self, delay: f64, now: f64, effects: &mut Vec<Effect>) {
        self.stopped = false;
        self.dirty = true;
        effects.push(Effect::ClearFailure);
        if self.in_flight() {
            self.queued = true;
            return;
        }
        // DM lane admission can make other work eligible before this deadline.
        if self.manual_retry && self.due.is_some_and(|due| now + delay < due) {
            self.cancel_timer(effects);
        }
        self.schedule(delay, now, effects);
    }

    fn ready(&self, epoch: Option<f64>, effects: &mut Vec<Effect>) {
        if self.closed || epoch.is_none() {
            return;
        }
        if let Some(read) = self
            .in_flight
            .filter(|read| self.is_current(read.generation))
        {
            if read.epoch == epoch {
                effects.push(Effect::Hide {
                    reason: ReadReason::Reconcile,
                    demand: None,
                });
                effects.push(Effect::Return);
                return;
            }
            if read.epoch.is_none() {
                effects.push(Effect::InvalidateForReady);
                return;
            }
        }
        if self.accepted_epoch == epoch {
            effects.push(Effect::ReadyCovered);
            effects.push(Effect::Return);
        }
    }

    fn replace_fenced(
        &mut self,
        serving_notice: bool,
        reasons: Vec<ReadReason>,
        now: f64,
        effects: &mut Vec<Effect>,
    ) {
        self.notice_pending |= serving_notice;
        if self.dirty {
            self.restore_demand(false, reasons);
            if !self.retry {
                if self.ready_replacement == Some(self.generation) {
                    effects.push(Effect::Run);
                } else {
                    self.schedule(DEBOUNCE_MS, now, effects);
                }
            }
        }
    }

    fn retry_failure(
        &mut self,
        read: Read,
        serving_notice: bool,
        reasons: Vec<ReadReason>,
        failure: Failure,
        now: f64,
        effects: &mut Vec<Effect>,
    ) {
        if failure.transient() {
            self.restore_demand(serving_notice, reasons);
            self.backoff(failure.retry_after.unwrap_or(0.0), effects);
        } else if !self.is_current(read.generation) {
            self.replace_fenced(serving_notice, reasons, now, effects);
        } else if self.queued && self.retry_queued_terminal {
            self.notice_pending |= serving_notice;
            self.schedule(DEBOUNCE_MS, now, effects);
        } else {
            self.stop();
        }
        effects.push(Effect::ReturnIfCurrent);
    }
}

#[cfg(test)]
mod tests;
