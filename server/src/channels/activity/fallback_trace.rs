use super::{Buffer, Check, Entry, Epoch};
use crate::lock_ignoring_poison;
use crate::observability::{measurement_ms, revocation_trace::Pass};
use std::{
    collections::HashMap,
    fmt::{self, Display, Formatter},
    sync::Arc,
};
use uuid::Uuid;

pub(super) struct FallbackTrace {
    pass: Pass,
    snapshots: Vec<Snapshot>,
    registrations: Vec<Registration>,
    indices: HashMap<Uuid, usize>,
}

impl FallbackTrace {
    pub(super) fn start() -> Option<Self> {
        Some(Self {
            pass: Pass::start()?,
            snapshots: Vec::new(),
            registrations: Vec::new(),
            indices: HashMap::new(),
        })
    }

    pub(super) fn capture(
        &mut self,
        entry: &Arc<Entry>,
        buffer: &Buffer,
        checks: &[Check],
        cutoff: u64,
    ) {
        let mut snapshot = Snapshot {
            member: entry.member.0,
            checks: checks.len(),
            ..Snapshot::default()
        };
        for check in checks {
            snapshot.verified += usize::from(!check.needs_recheck);
            snapshot.channels_xor ^= check.channel.as_u128();
            snapshot.ids_xor ^= check.id;
        }
        snapshot.queued = buffer.pending.iter().filter(|pending| {
            matches!(&pending.epoch, Epoch::Revocation(capture) if capture.check().is_some_and(|check| check.id <= cutoff))
        }).count();
        self.snapshots.push(snapshot);
        self.indices.insert(entry.id, self.registrations.len());
        self.registrations.push(Registration {
            entry: entry.clone(),
            cutoff,
            checks: checks.len(),
            admission: None,
        });
    }

    pub(super) fn snapshot(&mut self, scanned: usize) {
        let snapshots = std::mem::take(&mut self.snapshots);
        self.pass
            .snapshot(scanned, snapshots.len(), Records(&snapshots));
    }

    pub(super) fn chunk(&mut self, rows: usize) {
        self.pass.chunk(rows);
    }

    pub(super) fn failed_chunk(&mut self) {
        self.pass.failed_chunk();
    }

    pub(super) fn first_admission(&mut self, id: Uuid) -> Option<&mut Disposition> {
        let index = *self.indices.get(&id)?;
        let admission = &mut self.registrations[index].admission;
        // A registration can span failed chunks. Even an all-gone first visit is final.
        if admission.is_some() {
            return None;
        }
        Some(admission.insert(Disposition::default()))
    }

    pub(super) fn finish(self) {
        let outcomes: Vec<_> = self
            .registrations
            .into_iter()
            .map(Registration::finish)
            .collect();
        self.pass.finish(!outcomes.is_empty(), Records(&outcomes));
    }
}

#[derive(Default)]
struct Snapshot {
    member: Uuid,
    checks: usize,
    queued: usize,
    verified: usize,
    channels_xor: u128,
    ids_xor: u64,
}

impl Display for Snapshot {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        let Self {
            member,
            checks,
            queued,
            verified,
            channels_xor,
            ids_xor,
        } = self;
        write!(
            f,
            "{member}:{checks}:{queued}:{verified}:{channels_xor:032x}:{ids_xor}"
        )
    }
}

struct Registration {
    entry: Arc<Entry>,
    cutoff: u64,
    checks: usize,
    admission: Option<Disposition>,
}

impl Registration {
    fn finish(self) -> Outcome {
        let disposition = self.admission.unwrap_or_else(|| {
            let buffer = lock_ignoring_poison(&self.entry.buffer);
            let mut disposition = Disposition::default();
            for check in buffer
                .revocations
                .checks()
                .into_iter()
                .take_while(|check| check.id <= self.cutoff)
            {
                disposition.unverified += usize::from(check.needs_recheck);
                disposition.verified += usize::from(!check.needs_recheck);
                disposition.ids_xor ^= check.id;
            }
            disposition
        });
        Outcome {
            member: self.entry.member.0,
            gone: self.checks
                - (disposition.held
                    + disposition.refused
                    + disposition.closed
                    + disposition.verified
                    + disposition.unverified),
            disposition,
        }
    }
}

#[derive(Default)]
pub(super) struct Disposition {
    held: usize,
    refused: usize,
    closed: usize,
    verified: usize,
    unverified: usize,
    ids_xor: u64,
    admitted_ms: Option<f64>,
}

impl Disposition {
    pub(super) fn record(&mut self, id: u64, held: bool, live: bool) {
        if held {
            self.held += 1;
        } else if live {
            self.closed += 1;
        } else {
            self.refused += 1;
        }
        self.ids_xor ^= id;
    }

    pub(super) fn complete(&mut self) {
        self.admitted_ms = Some(measurement_ms());
    }
}

struct Outcome {
    member: Uuid,
    gone: usize,
    disposition: Disposition,
}

impl Display for Outcome {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        let Self {
            member,
            gone,
            disposition,
        } = self;
        let Disposition {
            held,
            refused,
            closed,
            verified,
            unverified,
            ids_xor,
            admitted_ms,
        } = disposition;
        write!(
            f,
            "{member}:{held}:{refused}:{closed}:{verified}:{unverified}:{gone}:{ids_xor}:"
        )?;
        match admitted_ms {
            Some(ms) => Display::fmt(ms, f),
            None => f.write_str("-"),
        }
    }
}

struct Records<'a, T>(&'a [T]);

impl<T: Display> Display for Records<'_, T> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        let mut records = self.0.iter();
        if let Some(first) = records.next() {
            first.fmt(f)?;
        }
        for record in records {
            write!(f, ",{record}")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
