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
    Seed {
        root: String,
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
            CountInput::Seed { root, seq } => {
                if let Some(r) = self.roots.get_mut(&root)
                    && seq >= r.floor
                    && r.baseline.is_none_or(|(w, _)| seq >= w)
                {
                    r.baseline = Some((seq, 0));
                    r.evidence.retain(|_, evidence_seq| *evidence_seq > seq);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn track(core: &mut ReplyCounts, roots: &[&str]) -> Vec<CountTicket> {
        core.step(CountInput::Track {
            roots: roots.iter().map(|id| (*id).to_owned()).collect(),
        })
        .tickets
    }
    fn create(core: &mut ReplyCounts, root: &str, seq: i64) {
        core.step(CountInput::Create {
            root: root.to_owned(),
            id: format!("m{seq}"),
            seq,
        });
    }
    fn install(core: &mut ReplyCounts, ticket: &CountTicket, watermark: i64, count: i64) {
        core.step(CountInput::Install {
            ticket: ticket.clone(),
            watermark,
            count,
        });
    }

    #[test]
    fn baselines_reconcile_unique_suffix_and_never_rewind() {
        let mut core = ReplyCounts::default();
        let ticket = track(&mut core, &["r"])[0].clone();
        create(&mut core, "r", 11);
        create(&mut core, "r", 12);
        create(&mut core, "r", 12);
        install(&mut core, &ticket, 10, 4);
        assert_eq!(core.view().counts["r"], Some(6));
        install(&mut core, &ticket, 11, 5);
        install(&mut core, &ticket, 9, 999);
        create(&mut core, "r", 11);
        assert_eq!(core.view().counts["r"], Some(6));
    }

    #[test]
    fn overflow_floors_and_reset_fence_stale_tickets() {
        let mut core = ReplyCounts::default();
        let ticket = track(&mut core, &["r"])[0].clone();
        for seq in 1..=401 {
            create(&mut core, "r", seq);
        }
        let next = core.view().needed[0].clone();
        assert_ne!(ticket.generation, next.generation);
        install(&mut core, &ticket, 500, 500);
        install(&mut core, &next, 400, 400);
        assert_eq!(core.view().counts["r"], None);
        for seq in 1..=401 {
            create(&mut core, "r", seq);
        }
        create(&mut core, "r", 402);
        install(&mut core, &next, 401, 401);
        assert_eq!(core.view().counts["r"], Some(402));
        let reset = core.step(CountInput::Reset).needed[0].clone();
        install(&mut core, &next, 1000, 1000);
        assert_eq!(core.view().counts["r"], None);
        install(&mut core, &reset, 1, 7);
        assert_eq!(core.view().counts["r"], Some(7));
    }

    #[test]
    fn mutation_and_eviction_fence_only_the_affected_root() {
        let mut core = ReplyCounts::default();
        let tickets = track(&mut core, &["r", "s"]);
        core.step(CountInput::Begin {
            tickets: tickets.clone(),
        });
        core.step(CountInput::Invalidate {
            root: "r".to_owned(),
            seq: 12,
        });
        install(&mut core, &tickets[0], 13, 999);
        install(&mut core, &tickets[1], 10, 5);
        assert_eq!(core.view().counts["r"], None);
        assert_eq!(core.view().counts["s"], Some(5));
        let next = core.view().needed[0].clone();
        install(&mut core, &next, 11, 9);
        assert_eq!(core.view().counts["r"], None);
        install(&mut core, &next, 12, 4);
        track(&mut core, &["s"]);
        track(&mut core, &["s", "r"]);
        install(&mut core, &next, 13, 999);
        assert_eq!(core.view().counts["r"], None);
        assert_eq!(core.view().counts["s"], Some(5));
    }

    #[test]
    fn duplicate_and_late_move_preserve_covering_reply_count() {
        let mut core = ReplyCounts::default();
        let ticket = track(&mut core, &["r"])[0].clone();
        let moved = |seq| CountInput::Invalidate {
            root: "r".to_owned(),
            seq,
        };
        install(&mut core, &ticket, 10, 4);
        let next = core.step(moved(12)).needed[0].clone();
        core.step(CountInput::Begin {
            tickets: vec![next.clone()],
        });
        create(&mut core, "r", 13);
        for seq in [12, 11] {
            let view = core.step(moved(seq));
            assert_eq!(view.counts["r"], None);
            assert_eq!(view.tickets.len(), 1);
            assert_eq!(view.tickets[0].root, next.root);
            assert_eq!(view.tickets[0].generation, next.generation);
            assert!(view.needed.is_empty());
        }
        install(&mut core, &next, 12, 4);
        assert_eq!(core.view().counts["r"], Some(5));
        create(&mut core, "r", 13);
        for seq in [12, 11] {
            let view = core.step(moved(seq));
            assert_eq!(view.counts["r"], Some(5));
            assert!(view.needed.is_empty());
        }
    }

    #[test]
    fn root_seed_keeps_unique_suffix_and_newer_authority() {
        let mut core = ReplyCounts::default();
        let ticket = track(&mut core, &["r"])[0].clone();
        create(&mut core, "r", 12);
        core.step(CountInput::Seed {
            root: "r".to_owned(),
            seq: 10,
        });
        assert_eq!(core.view().counts["r"], Some(1));
        install(&mut core, &ticket, 13, 4);
        core.step(CountInput::Seed {
            root: "r".to_owned(),
            seq: 10,
        });
        assert_eq!(core.view().counts["r"], Some(4));
    }
}
