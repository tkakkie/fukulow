#[cfg(test)]
use super::test_hooks::test_pause;
use super::{
    Activity,
    authorize::authorize_batch,
    buffer::{Buffer, Proof, QueryToken},
    fallback_trace, holds,
    notice_budget::NoticeBudget,
    revocations::Check,
};
use crate::{
    auth, lock_ignoring_poison,
    observability::{notice_permits::NoticeCaller, revocation_trace},
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use uuid::Uuid;

struct NoticeRecheck {
    channel: Option<Uuid>,
    epoch: u64,
    proof: Option<Proof>,
    valid: Option<Arc<QueryToken>>,
}
impl NoticeRecheck {
    fn apply(&self, b: &mut Buffer, current: Option<&Proof>) {
        if b.epoch != self.epoch
            || self
                .proof
                .as_ref()
                .is_some_and(|proof| current == Some(proof))
        {
            return;
        }
        // Unknown provenance fences only that query. The query may already
        // have completed since this fallback's snapshot.
        if self.proof.is_none()
            && current.is_some()
            && let Some(valid) = &self.valid
        {
            let changed = b
                .proofs
                .get(&self.channel)
                .is_some_and(|known| current != Some(known))
                || b.in_flight.values().any(|authorization| {
                    authorization.channel == self.channel
                        && authorization
                            .proof
                            .as_ref()
                            .is_some_and(|known| current != Some(known))
                });
            if !changed {
                valid.retire();
                for authorization in b.in_flight.values().filter(|authorization| {
                    authorization.channel == self.channel && authorization.proof.is_none()
                }) {
                    authorization.valid.retire();
                }
                return;
            }
        }
        if self.channel.is_none() && current.is_none() {
            b.revocations.retire_member();
        }
        b.retire_notices();
    }
}

enum Recheck {
    Notice(NoticeRecheck),
    Revocation(Check),
}
impl Activity {
    pub(crate) async fn check(&self, pool: &sqlx::PgPool, scope: auth::SubscriptionScope) {
        let timing =
            matches!(scope, auth::SubscriptionScope::All) && revocation_trace::timing_enabled();
        let mut trace = if timing {
            fallback_trace::FallbackTrace::start()
        } else {
            None
        };
        let entries: Vec<_> = lock_ignoring_poison(&self.entries)
            .values()
            .filter(|e| match scope {
                auth::SubscriptionScope::All => true,
                auth::SubscriptionScope::Member(org, member) => {
                    e.organization == org && e.member.0 == member
                }
                auth::SubscriptionScope::Channel(org, _) => e.organization == org,
            })
            .cloned()
            .collect();
        let scanned = entries.len();
        let mut organizations = std::collections::BTreeMap::<_, Vec<_>>::new();
        let mut revocation_cutoffs = HashMap::new();
        for entry in entries {
            let b = lock_ignoring_poison(&entry.buffer);
            let rows = organizations.entry(entry.organization).or_default();
            rows.extend(b.proofs.iter().map(|(&channel, proof)| {
                (
                    entry.clone(),
                    Recheck::Notice(NoticeRecheck {
                        channel,
                        epoch: b.epoch,
                        proof: Some(proof.clone()),
                        valid: None,
                    }),
                )
            }));
            rows.extend(b.in_flight.values().filter(|a| a.valid.valid()).map(|a| {
                (
                    entry.clone(),
                    Recheck::Notice(NoticeRecheck {
                        channel: a.channel,
                        epoch: b.epoch,
                        proof: a.proof.clone(),
                        valid: Some(a.valid.clone()),
                    }),
                )
            }));
            let checks = b.revocations.checks();
            if let Some(last) = checks.last() {
                revocation_cutoffs.insert(entry.id, last.id);
                if let Some(trace) = &mut trace {
                    trace.capture(&entry, &b, &checks, last.id);
                }
            }
            rows.extend(
                checks
                    .into_iter()
                    .map(|check| (entry.clone(), Recheck::Revocation(check))),
            );
        }
        if let Some(trace) = &mut trace {
            trace.snapshot(scanned);
        }
        for rows in organizations.values() {
            let mut remaining = rows.as_slice();
            while !remaining.is_empty() {
                let mut selected = Vec::new();
                let mut offsets = Vec::new();
                for (entry, row) in remaining {
                    let (channel, revocation_channel) = match row {
                        Recheck::Notice(notice) => (notice.channel, None),
                        Recheck::Revocation(check) => (
                            None,
                            Some(check.channel).filter(|checked| !matches!(scope, auth::SubscriptionScope::Channel(_, channel) if channel != *checked)),
                        ),
                    };
                    // Read both proofs in one snapshot without expanding the SQL batch.
                    let index = selected.len();
                    if index + 1 + usize::from(revocation_channel.is_some()) > 1000 {
                        break;
                    }
                    selected.push((entry.clone(), channel));
                    let access = revocation_channel.map(|channel| {
                        selected.push((entry.clone(), Some(channel)));
                        index + 1
                    });
                    offsets.push((index, access));
                }
                let (chunk, rest) = remaining.split_at(offsets.len());
                remaining = rest;
                if let Some(trace) = &mut trace {
                    trace.chunk(selected.len());
                }
                #[cfg(test)]
                for (entry, channel) in &selected {
                    test_pause(
                        entry.organization,
                        channel.unwrap_or(Uuid::nil()),
                        "fallback_snapshot",
                        Some(entry.member.0),
                    )
                    .await;
                }
                let proofs = if matches!(scope, auth::SubscriptionScope::All) {
                    // The Session worker runs this pass serially.
                    let _all_pass = NoticeBudget::all_pass(&self.notice_queries);
                    authorize_batch(pool, &selected, None)
                        .await
                        .map_err(Into::into)
                } else {
                    self.authorize(pool, &selected, NoticeCaller::Scoped).await
                };
                let Ok(proofs) = proofs else {
                    if let Some(trace) = &mut trace {
                        trace.failed_chunk();
                    }
                    if let Some((entry, _)) = chunk.first() {
                        lock_ignoring_poison(&entry.buffer).holds.recheck_error();
                    }
                    let mut seen = HashSet::new();
                    let mut admission_attempted = false;
                    for (entry, row) in chunk {
                        let mut b = if let Some(&cutoff) = revocation_cutoffs.get(&entry.id)
                            && seen.insert(entry.id)
                        {
                            let (mut b, now) = holds::lock_for_admission(entry);
                            admission_attempted |= timing;
                            let mut admission = trace
                                .as_mut()
                                .and_then(|trace| trace.first_admission(entry.id));
                            let Buffer {
                                holds, revocations, ..
                            } = &mut *b;
                            let mut checks = revocations
                                .checks()
                                .into_iter()
                                .take_while(|check| check.id <= cutoff)
                                .peekable();
                            if checks.peek().is_some() {
                                for check in checks {
                                    holds.start(entry, revocations, check.id, now);
                                    if let Some(record) = &mut admission {
                                        let held = holds.deadline(check.id).is_some();
                                        record.record(
                                            check.id,
                                            held,
                                            !held && revocations.check(check.id).is_some(),
                                        );
                                    }
                                }
                                b.retire_notices();
                                entry.wake.notify_one();
                            }
                            if let Some(record) = admission {
                                record.complete();
                            }
                            b
                        } else {
                            lock_ignoring_poison(&entry.buffer)
                        };
                        if let Recheck::Notice(notice) = row
                            && b.epoch == notice.epoch
                        {
                            b.retire_notices();
                        }
                    }
                    if admission_attempted {
                        revocation_trace::admission_finished();
                    }
                    continue;
                };
                let proof = |index: usize| proofs[index].as_ref();
                for ((entry, row), (index, access)) in chunk.iter().zip(offsets) {
                    let current = proof(index);
                    let mut b = lock_ignoring_poison(&entry.buffer);
                    match row {
                        Recheck::Notice(notice) => notice.apply(&mut b, current),
                        Recheck::Revocation(check) => {
                            b.apply_revocation(*check, current, access.map(|i| proof(i).is_some()));
                        }
                    }
                }
            }
        }
        if let Some(trace) = trace {
            trace.finish();
        }
    }
}
