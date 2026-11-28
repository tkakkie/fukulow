#[cfg(test)]
use super::test_hooks::test_pause;
use super::{
    Entry, Notice,
    authorize::authorize_batch,
    buffer::{Buffer, Epoch, Pending, QueryToken, Recovery},
    holds,
    notice_budget::{NoticeBudget, notice_query_slot},
    revocations::Check,
};
use crate::{lock_ignoring_poison, observability::notice_permits::NoticeCaller};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;

pub(crate) struct NoticeFrame {
    pub(super) entry: Arc<Entry>,
    pub(super) epoch: Epoch,
    pub(super) directory_epoch: Option<u64>,
    pub event: Notice,
    pub(super) valid: Arc<QueryToken>,
    pub(super) recovery: Option<Arc<Recovery>>,
    pub(super) retry: bool,
}

pub(super) enum RecheckFailure {
    Database,
    Deadline { caller: NoticeCaller, granted: bool },
}

impl NoticeFrame {
    pub(super) fn new(entry: &Arc<Entry>, pending: Pending, retry: bool) -> Self {
        Self {
            entry: entry.clone(),
            epoch: pending.epoch,
            directory_epoch: pending.directory_epoch,
            event: pending.notice,
            valid: pending.valid,
            recovery: pending.recovery,
            retry,
        }
    }

    fn parked(&self) -> Pending {
        Pending {
            notice: self.event.clone(),
            channel: None,
            epoch: self.epoch.clone(),
            directory_epoch: self.directory_epoch,
            proof: None,
            valid: self.valid.clone(),
            recovery: self.recovery.clone(),
        }
    }

    pub(crate) fn is_held_retry(&self) -> bool {
        self.retry
    }

    pub(crate) async fn handoff<F: std::future::Future>(
        &self,
        pool: &sqlx::PgPool,
        write: impl FnOnce(Notice) -> F,
    ) -> Option<F::Output> {
        self.poll_handoff(Some(pool), write).await
    }

    pub(super) async fn poll_handoff<F: std::future::Future>(
        &self,
        pool: Option<&sqlx::PgPool>,
        write: impl FnOnce(Notice) -> F,
    ) -> Option<F::Output> {
        let mut future = std::pin::pin!(async {
            // This body first runs under the handoff gate. Another contribution
            // authorizes recovery, never the discarded larger value.
            let event = if self.valid.valid() {
                self.event.clone()
            } else {
                Notice::ActivityReset
            };
            write(event).await
        });
        let mut first_poll = |cx: &mut std::task::Context<'_>, deadline: Option<Instant>| {
            let mut b = lock_ignoring_poison(&self.entry.buffer);
            if !(self.valid.valid() || self.recovery.as_ref().is_some_and(|r| r.valid()))
                || self
                    .directory_epoch
                    .is_some_and(|epoch| b.directory_epoch != epoch)
            {
                return std::task::Poll::Ready(Ok(None));
            }
            if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
                return std::task::Poll::Ready(Ok(None));
            }
            match &self.epoch {
                Epoch::Notice(epoch) if b.epoch != *epoch => {
                    return std::task::Poll::Ready(Ok(None));
                }
                Epoch::Notice(_) => {}
                Epoch::Revocation(capture) => {
                    let Buffer {
                        holds, revocations, ..
                    } = &mut *b;
                    holds.prune(revocations, Instant::now());
                    let Some(check) = capture.check() else {
                        return std::task::Poll::Ready(Ok(None));
                    };
                    let hold_deadline = holds.deadline(check.id);
                    if self.retry {
                        if hold_deadline.is_none() {
                            return std::task::Poll::Ready(Ok(None));
                        }
                    } else if hold_deadline.is_some() {
                        return std::task::Poll::Ready(Ok(None));
                    }
                    if check.needs_recheck {
                        let retry_measurement = if self.retry {
                            holds.retry_measurement()
                        } else {
                            None
                        };
                        return std::task::Poll::Ready(Err((
                            check,
                            hold_deadline,
                            retry_measurement,
                        )));
                    }
                    holds.complete(
                        check.id,
                        self.valid.valid()
                            && matches!(self.event, Notice::ChannelAccessRevoked { .. }),
                    );
                    revocations.finish(check.id);
                }
            }
            std::task::Poll::Ready(Ok(Some(std::future::Future::poll(future.as_mut(), cx))))
        };
        let mut deadline = None;
        let mut last_checked = None;
        let first = loop {
            match std::future::poll_fn(|cx| first_poll(cx, deadline)).await {
                Ok(first) => break first,
                Err((check, hold_deadline, retry_measurement)) => {
                    let checked = (check.generation, check.revision);
                    if last_checked.is_some_and(|last| self.retry || checked <= last) {
                        break None;
                    }
                    last_checked = Some(checked);
                    let deadline = *deadline.get_or_insert_with(|| {
                        let limit = Instant::now() + Duration::from_secs(5);
                        hold_deadline.map_or(limit, |expires| expires.min(limit))
                    });
                    let Some(pool) = pool else { break None };
                    match self
                        .recheck_revocation(pool, check, deadline, retry_measurement)
                        .await
                    {
                        Ok(()) => {}
                        Err(RecheckFailure::Deadline { caller, granted }) => {
                            if let Some(gauges) =
                                NoticeBudget::measurement(&self.entry.notice_queries)
                            {
                                gauges.deadline_exit(caller, granted);
                            }
                            break None;
                        }
                        Err(RecheckFailure::Database) => {
                            if self.retry {
                                let b = lock_ignoring_poison(&self.entry.buffer);
                                b.holds.recheck_error();
                            } else {
                                let (mut b, now) = holds::lock_for_admission(&self.entry);
                                let Buffer {
                                    holds, revocations, ..
                                } = &mut *b;
                                holds.recheck_error();
                                holds.start(&self.entry, revocations, check.id, now);
                            }
                            break None;
                        }
                    }
                }
            }
        };
        if first.is_none()
            && let Epoch::Revocation(capture) = &self.epoch
        {
            let mut b = lock_ignoring_poison(&self.entry.buffer);
            let Buffer {
                holds, revocations, ..
            } = &mut *b;
            let now = Instant::now();
            holds.prune(revocations, now);
            if let Some(check) = capture.check() {
                if self.retry {
                    holds.retry_failed(revocations, check.id, self.parked(), now);
                } else {
                    // Fallback can admit a hold while the initial query is in flight.
                    holds.park(check.id, || self.parked());
                }
            }
        }
        Some(match first? {
            std::task::Poll::Ready(value) => value,
            std::task::Poll::Pending => future.await,
        })
    }
    pub(super) async fn recheck_revocation(
        &self,
        pool: &sqlx::PgPool,
        check: Check,
        deadline: Instant,
        retry_measurement: Option<Arc<holds::Capacity>>,
    ) -> Result<(), RecheckFailure> {
        let selected = [
            (self.entry.clone(), None),
            (self.entry.clone(), Some(check.channel)),
        ];
        let caller = if self.retry {
            NoticeCaller::Retry
        } else {
            NoticeCaller::Handoff
        };
        let granted = AtomicBool::new(false);
        let proofs = tokio::time::timeout_at(deadline, async {
            #[cfg(test)]
            test_pause(
                self.entry.organization,
                check.channel,
                "handoff_recheck",
                Some(self.entry.member.0),
            )
            .await;
            let slot = notice_query_slot(&self.entry.notice_queries, pool, caller).await?;
            if slot.recording() {
                granted.store(true, Ordering::Relaxed);
            }
            if let Some(capacity) = retry_measurement {
                capacity.count_retry_attempt();
            }
            authorize_batch(pool, &selected, Some(&slot)).await
        })
        .await
        .map_err(|_| RecheckFailure::Deadline {
            caller,
            granted: granted.load(Ordering::Relaxed),
        })?
        .map_err(|_| RecheckFailure::Database)?;
        let mut b = lock_ignoring_poison(&self.entry.buffer);
        if self.retry {
            b.apply_revocation_proof(check, proofs[0].as_ref(), Some(proofs[1].is_some()));
        } else {
            b.apply_revocation(check, proofs[0].as_ref(), Some(proofs[1].is_some()));
        }
        Ok(())
    }
}
