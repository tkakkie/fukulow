//! Authoritative Reply totals, independent of retained Message bodies and sync cursors.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

const EVIDENCE_LIMIT: usize = 400;

#[derive(Default)]
pub struct ReplyCounts {
    roots: BTreeMap<String, Root>,
    next: u64,
}
#[derive(Default)]
struct Root {
    generation: u64,
    baseline: Option<(i64, i64)>,
    floor: i64,
    evidence: BTreeMap<String, i64>,
    pending: bool,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CountInput {
    Track {
        roots: BTreeSet<String>,
    },
    Reset,
    Begin {
        tickets: Vec<CountTicket>,
    },
    Failed {
        tickets: Vec<CountTicket>,
    },
    Install {
        ticket: CountTicket,
        watermark: i64,
        count: i64,
    },
    Create {
        root: String,
        id: String,
        seq: i64,
    },
    Invalidate {
        root: String,
        seq: i64,
    },
}
#[derive(Clone, Deserialize, Serialize)]
pub struct CountTicket {
    pub root: String,
    pub generation: u64,
}
#[derive(Serialize)]
pub struct CountView {
    pub counts: BTreeMap<String, Option<i64>>,
    pub needed: Vec<CountTicket>,
    pub tickets: Vec<CountTicket>,
}
impl ReplyCounts {
    fn generation(&mut self) -> u64 {
        self.next += 1;
        self.next
    }
    fn invalidate(&mut self, root: &str, floor: i64) {
        let generation = self.generation();
        if let Some(r) = self.roots.get_mut(root) {
            r.generation = generation;
            r.baseline = None;
            r.pending = false;
            r.floor = r.floor.max(floor);
            r.evidence.retain(|_, seq| *seq > r.floor);
        }
    }
    fn pending(&mut self, tickets: Vec<CountTicket>, pending: bool) {
        for ticket in tickets {
            if let Some(r) = self.roots.get_mut(&ticket.root)
                && r.generation == ticket.generation
            {
                r.pending = pending;
            }
        }
    }
    pub fn step(&mut self, input: CountInput) -> CountView {
        match input {
            CountInput::Track { roots } => {
                self.roots.retain(|id, _| roots.contains(id));
                for id in roots {
                    if !self.roots.contains_key(&id) {
                        let generation = self.generation();
                        self.roots.insert(
                            id,
                            Root {
                                generation,
                                ..Root::default()
                            },
                        );
                    }
                }
            }
            CountInput::Reset => {
                let ids: Vec<_> = self.roots.keys().cloned().collect();
                for id in ids {
                    let generation = self.generation();
                    self.roots.insert(
                        id,
                        Root {
                            generation,
                            ..Root::default()
                        },
                    );
                }
            }
            CountInput::Begin { tickets } => self.pending(tickets, true),
            CountInput::Failed { tickets } => self.pending(tickets, false),
            CountInput::Install {
                ticket,
                watermark,
                count,
            } => {
                if let Some(r) = self.roots.get_mut(&ticket.root)
                    && r.generation == ticket.generation
                {
                    r.pending = false;
                    if watermark >= r.floor && r.baseline.is_none_or(|(w, _)| watermark >= w) {
                        r.baseline = Some((watermark, count));
                        r.evidence.retain(|_, seq| *seq > watermark);
                    }
                }
            }
            CountInput::Create { root, id, seq } => {
                if let Some(r) = self.roots.get_mut(&root)
                    && seq > r.floor
                    && r.baseline.is_none_or(|(w, _)| seq > w)
                {
                    r.evidence.entry(id).or_insert(seq);
                }
            }
            // #160/#141/#287: mutation deltas and tombstone/Move delivery remain open.
            // Require a fresh snapshot covering the mutation instead of guessing a delta.
            CountInput::Invalidate { root, seq } => {
                if self
                    .roots
                    .get(&root)
                    .is_some_and(|r| seq > r.floor && r.baseline.is_none_or(|(w, _)| seq > w))
                {
                    self.invalidate(&root, seq);
                }
            }
        }
        while self.roots.values().map(|r| r.evidence.len()).sum::<usize>() > EVIDENCE_LIMIT {
            let oldest = self
                .roots
                .iter()
                .filter_map(|(id, r)| r.evidence.values().min().map(|seq| (id.clone(), *seq)))
                .min_by_key(|(_, seq)| *seq);
            let Some((id, _)) = oldest else { break };
            let floor = self.roots[&id]
                .evidence
                .values()
                .copied()
                .max()
                .unwrap_or(0);
            self.invalidate(&id, floor);
        }
        self.view()
    }
    pub fn view(&self) -> CountView {
        let ticket = |(id, r): (&String, &Root)| CountTicket {
            root: id.clone(),
            generation: r.generation,
        };
        CountView {
            counts: self
                .roots
                .iter()
                .map(|(id, r)| {
                    (
                        id.clone(),
                        r.baseline.map(|(_, count)| count + r.evidence.len() as i64),
                    )
                })
                .collect(),
            needed: self
                .roots
                .iter()
                .filter(|(_, r)| r.baseline.is_none() && !r.pending)
                .map(ticket)
                .collect(),
            tickets: self.roots.iter().map(ticket).collect(),
        }
    }
}
