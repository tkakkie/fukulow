use super::{ActivityReads, Effect, Failure, Input, Read, ReadReason};

fn drive(core: &mut ActivityReads, input: Input) -> Vec<Effect> {
    core.step(input, 0.0)
}

fn start(core: &mut ActivityReads, epoch: Option<f64>, reasons: &[ReadReason]) -> Read {
    assert_eq!(drive(core, Input::Run), [Effect::CheckCanLoad]);
    let effects = drive(core, Input::Start { epoch });
    let [
        Effect::ClearFailure,
        Effect::Start {
            read,
            reasons: started,
        },
    ] = effects.as_slice()
    else {
        panic!("expected a read, got {effects:?}");
    };
    assert_eq!(read.epoch, epoch);
    assert_eq!(started, reasons);
    *read
}

fn complete(core: &mut ActivityReads, serving_notice: bool) {
    assert_eq!(
        drive(core, Input::ReadCompleted { cancelled: false }),
        [Effect::Finish { serving_notice }],
    );
}

fn success(read: Read, reason: ReadReason) -> Input {
    Input::Success {
        read,
        serving_notice: reason == ReadReason::Notice,
        reasons: vec![reason],
    }
}

fn retry_failure(read: Read, reason: ReadReason, status: f64) -> Input {
    Input::RetryFailure {
        read,
        serving_notice: reason == ReadReason::Notice,
        reasons: vec![reason],
        failure: Failure {
            network: false,
            status: Some(status),
            retry_after: None,
        },
    }
}

fn assert_access_fences_denial(status: f64) {
    let mut core = ActivityReads::default();
    assert_eq!(drive(&mut core, Input::Ensure), [Effect::Run]);
    let old = start(&mut core, Some(1.0), &[ReadReason::Initial]);

    assert_eq!(
        drive(
            &mut core,
            Input::Invalidate {
                reason: ReadReason::Access,
                delay: 200.0
            }
        ),
        [Effect::Hide {
            reason: ReadReason::Access,
            demand: Some(200.0)
        }],
    );
    drive(&mut core, Input::Demand { delay: 200.0 });
    complete(&mut core, false);
    assert!(drive(&mut core, Input::Failure { read: old }).is_empty());
    assert!(drive(&mut core, Input::CheckTerminal { read: old }).is_empty());
    assert_eq!(
        drive(&mut core, retry_failure(old, ReadReason::Initial, status)),
        [
            Effect::Schedule {
                generation: old.generation + 1,
                delay: 200.0
            },
            Effect::ReturnIfCurrent
        ],
    );
    assert!(!core.is_current(old.generation));

    assert_eq!(
        drive(&mut core, Input::FlushQueued),
        [Effect::CancelTimer, Effect::Run]
    );
    let fresh = start(
        &mut core,
        Some(1.0),
        &[ReadReason::Access, ReadReason::Initial],
    );
    complete(&mut core, false);
    assert!(core.is_current(fresh.generation));
    assert_eq!(
        drive(&mut core, Input::Failure { read: fresh }),
        [Effect::Error]
    );
    assert_eq!(
        drive(&mut core, Input::CheckTerminal { read: fresh }),
        [Effect::CheckTerminal]
    );
    assert_eq!(
        drive(&mut core, retry_failure(fresh, ReadReason::Access, status)),
        [Effect::ReturnIfCurrent]
    );
    assert!(drive(&mut core, Input::Ensure).is_empty());
}

#[test]
fn access_fence_denies_stale_401() {
    assert_access_fences_denial(401.0);
}

#[test]
fn access_fence_denies_stale_403() {
    assert_access_fences_denial(403.0);
}

#[test]
fn access_fence_denies_stale_404() {
    assert_access_fences_denial(404.0);
}

#[test]
fn terminal_stop_drops_queued_demand_until_explicit_retry() {
    let mut core = ActivityReads::new(false, true, false);
    drive(
        &mut core,
        Input::Invalidate {
            reason: ReadReason::Notice,
            delay: 0.0,
        },
    );
    drive(&mut core, Input::FlushQueued);
    let read = start(&mut core, None, &[ReadReason::Notice]);
    assert_eq!(
        drive(
            &mut core,
            Input::Refresh {
                reason: ReadReason::Periodic
            }
        ),
        [Effect::Join]
    );
    complete(&mut core, true);
    assert_eq!(drive(&mut core, Input::Failure { read }), [Effect::Error]);
    assert_eq!(
        drive(&mut core, Input::CheckTerminal { read }),
        [Effect::CheckTerminal]
    );
    assert_eq!(drive(&mut core, Input::Stop), [Effect::Return]);

    assert!(!core.pending_notice());
    assert!(!core.idle());
    assert!(drive(&mut core, Input::Ensure).is_empty());
    assert!(drive(&mut core, Input::FlushQueued).is_empty());
    assert_eq!(
        drive(&mut core, Input::RetryNow),
        [Effect::ClearFailure, Effect::Run]
    );
    start(&mut core, None, &[]);
}

#[test]
fn suspension_aborts_the_read_and_preserves_only_fresh_demand() {
    let mut core = ActivityReads::default();
    drive(
        &mut core,
        Input::Invalidate {
            reason: ReadReason::Notice,
            delay: 0.0,
        },
    );
    drive(&mut core, Input::FlushQueued);
    let old = start(&mut core, Some(1.0), &[ReadReason::Notice]);
    assert!(core.pending_notice());
    assert_eq!(drive(&mut core, Input::Suspend), [Effect::Abort]);
    assert!(!core.is_current(old.generation));
    assert!(!core.pending_notice());

    drive(
        &mut core,
        Input::Invalidate {
            reason: ReadReason::Notice,
            delay: 200.0,
        },
    );
    assert_eq!(
        drive(&mut core, Input::ReadCompleted { cancelled: true }),
        [Effect::Schedule {
            generation: old.generation + 1,
            delay: 0.0
        }],
    );
    assert_eq!(
        drive(
            &mut core,
            Input::Deadline {
                generation: old.generation + 1
            }
        ),
        [Effect::Run]
    );
    let fresh = start(&mut core, Some(2.0), &[ReadReason::Notice]);
    complete(&mut core, true);
    assert_eq!(
        drive(&mut core, success(fresh, ReadReason::Notice)),
        [Effect::CheckCoverage]
    );
}

#[test]
fn close_cancels_backoff_and_never_restarts() {
    let mut core = ActivityReads::default();
    drive(&mut core, Input::Ensure);
    let read = start(&mut core, Some(1.0), &[ReadReason::Initial]);
    complete(&mut core, false);
    assert_eq!(
        drive(&mut core, retry_failure(read, ReadReason::Initial, 503.0)),
        [
            Effect::Backoff {
                cap: 1000.0,
                retry_after: 0.0
            },
            Effect::ReturnIfCurrent
        ],
    );
    assert_eq!(
        drive(
            &mut core,
            Input::RetryDelay {
                cap: 1000.0,
                retry_after: 0.0,
                draw: 0.0
            }
        ),
        [Effect::Schedule {
            generation: read.generation,
            delay: 500.0
        }],
    );
    assert_eq!(
        drive(&mut core, Input::Close),
        [Effect::CancelTimer, Effect::Abort]
    );
    assert!(
        drive(
            &mut core,
            Input::Deadline {
                generation: read.generation
            }
        )
        .is_empty()
    );
    assert!(drive(&mut core, Input::Run).is_empty());
    assert!(drive(&mut core, Input::Ensure).is_empty());
}

#[test]
fn fence_rearms_the_remaining_delay_and_rejects_the_old_deadline() {
    let mut core = ActivityReads::default();
    let scheduled = |generation, delay| Effect::Schedule { generation, delay };
    assert_eq!(
        drive(
            &mut core,
            Input::Invalidate {
                reason: ReadReason::Notice,
                delay: 200.0
            }
        ),
        [Effect::ClearFailure, scheduled(0, 200.0)],
    );
    assert_eq!(
        core.step(Input::Fence, 70.0),
        [Effect::CancelTimer, scheduled(1, 130.0)]
    );
    assert!(
        core.step(Input::Deadline { generation: 0 }, 200.0)
            .is_empty()
    );
    assert_eq!(
        core.step(Input::Deadline { generation: 1 }, 200.0),
        [Effect::Run]
    );
}

#[test]
fn stale_deadline_preserves_the_current_timer() {
    let mut core = ActivityReads::default();
    assert_eq!(
        drive(&mut core, Input::Demand { delay: 200.0 }),
        [
            Effect::ClearFailure,
            Effect::Schedule {
                generation: 0,
                delay: 200.0,
            },
        ]
    );
    assert_eq!(
        drive(&mut core, Input::Suspend),
        [Effect::CancelTimer, Effect::Abort]
    );
    assert_eq!(
        core.step(Input::Demand { delay: 200.0 }, 100.0),
        [
            Effect::ClearFailure,
            Effect::Schedule {
                generation: 1,
                delay: 200.0,
            },
        ]
    );

    assert_eq!(core.due, Some(300.0));
    assert!(
        core.step(Input::Deadline { generation: 0 }, 200.0)
            .is_empty()
    );
    assert_eq!(core.due, Some(300.0));
    assert_eq!(
        core.step(Input::FlushQueued, 200.0),
        [Effect::CancelTimer, Effect::Run]
    );
}

#[test]
fn access_fence_denies_stale_success_until_a_fresh_read_covers() {
    let mut core = ActivityReads::default();
    drive(&mut core, Input::Ensure);
    let old = start(&mut core, Some(1.0), &[ReadReason::Initial]);
    drive(&mut core, Input::Fence);
    complete(&mut core, false);
    assert_eq!(
        drive(&mut core, success(old, ReadReason::Initial)),
        [Effect::Schedule {
            generation: old.generation + 1,
            delay: 200.0
        }],
    );
    drive(&mut core, Input::FlushQueued);
    let fresh = start(&mut core, Some(1.0), &[ReadReason::Initial]);
    complete(&mut core, false);
    assert_eq!(
        drive(&mut core, success(fresh, ReadReason::Initial)),
        [Effect::CheckCoverage]
    );
}

#[test]
fn ready_reuses_only_the_current_connection_and_generation() {
    let mut core = ActivityReads::default();
    drive(&mut core, Input::Ensure);
    let read = start(&mut core, Some(1.0), &[ReadReason::Initial]);
    let ready = |epoch| Input::Ready { epoch: Some(epoch) };
    assert!(drive(&mut core, ready(2.0)).is_empty());
    assert_eq!(
        drive(&mut core, ready(1.0)),
        [
            Effect::Hide {
                reason: ReadReason::Reconcile,
                demand: None
            },
            Effect::Return
        ],
    );
    complete(&mut core, false);
    assert_eq!(
        drive(&mut core, success(read, ReadReason::Initial)),
        [Effect::CheckCoverage]
    );
    drive(
        &mut core,
        Input::Coverage {
            serving_notice: false,
            reasons: vec![ReadReason::Initial],
            covered: true,
        },
    );
    drive(
        &mut core,
        Input::Accept {
            read,
            covered: true,
        },
    );
    assert!(drive(&mut core, ready(2.0)).is_empty());
    assert_eq!(
        drive(&mut core, ready(1.0)),
        [Effect::ReadyCovered, Effect::Return]
    );

    drive(
        &mut core,
        Input::Refresh {
            reason: ReadReason::Reconcile,
        },
    );
    start(&mut core, Some(1.0), &[ReadReason::Reconcile]);
    drive(&mut core, Input::Fence);
    assert!(drive(&mut core, ready(1.0)).is_empty());
}
