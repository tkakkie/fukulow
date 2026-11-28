use crate::{engine::Step, *};
use fukulow_api::Message;
use std::{collections::BTreeMap, rc::Rc};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    Window,
    Ack,
    Stream,
    Events,
    Projection,
}

pub(super) fn same_message(a: &Message, b: &Message) -> bool {
    a.id == b.id
        && a.channel_id == b.channel_id
        && a.created_seq == b.created_seq
        && a.version == b.version
        && a.deleted == b.deleted
        && a.client_message_id == b.client_message_id
        && a.sender == b.sender
        && a.body == b.body
        && a.created_at == b.created_at
        && a.topic_id == b.topic_id
        && a.reply_to == b.reply_to
        && a.reply_root_id == b.reply_root_id
        && a.mentions == b.mentions
}
impl Step<'_> {
    /// A Create's envelope position is its creation position; a mismatched Create is
    /// dropped rather than moving the cursor past a different event.
    pub(crate) fn envelope_consistent(
        kind: fukulow_api::MessageStateKind,
        seq: i64,
        message: &Message,
    ) -> bool {
        !matches!(kind, fukulow_api::MessageStateKind::Create) || message.created_seq == seq
    }
    pub fn merge_move(&mut self, event: fukulow_api::MessageMoveEvent, source: Source) {
        if event.seq < 1 || event.version != event.seq {
            return;
        }
        let id = event.channel_id;
        let c = self.channel(id);
        let seen = c.cursor.is_some_and(|cursor| cursor >= event.seq)
            || c.advancing
                .iter()
                .any(|range| range.start <= event.seq && event.seq <= range.end);
        if seen {
            return;
        }
        if c.moved_roots
            .get(&event.root_id)
            .is_none_or(|seq| *seq < event.seq)
        {
            self.core.move_epoch += 1;
            let epoch = self.core.move_epoch;
            let c = self.channel(id);
            Rc::make_mut(&mut c.moved_roots).insert(event.root_id, event.seq);
            c.move_seq = c.move_seq.max(Some(event.seq));
            c.move_epoch = Some(epoch);
            c.mutation_seq = c.mutation_seq.max(event.seq);
            c.snapshot_seq = None;
            let current = |m: &Message| {
                m.reply_root_id.unwrap_or(m.id) != event.root_id || m.version >= event.seq
            };
            if c.messages.iter().any(|m| !current(m)) {
                let versions = Rc::make_mut(&mut c.versions);
                for m in c.messages.iter().filter(|m| !current(m)) {
                    versions
                        .entry(m.id)
                        .and_modify(|(version, _, _)| *version = (*version).max(event.seq))
                        .or_insert((event.seq, m.deleted, m.created_seq));
                }
                Rc::make_mut(&mut c.messages).retain(|m| current(m));
            }
            // A gap page can contain both a Message state and a later invalidation.
            self.out.records.retain_mut(|(channel, records)| {
                if *channel == id {
                    records.retain(&current);
                }
                !records.is_empty()
            });
            for request in self.core.requests.values_mut() {
                if matches!(request, Request::History { channel, page: Page::Before, stale: false, .. } if *channel == id)
                {
                    request.invalidate();
                    self.metadata_changed = true;
                }
            }
            self.channel(id).older = None;
            self.cap_moved_roots(id, MAIN_MESSAGE_LIMIT);
            self.out.moves.push(MoveVersion {
                channel_id: id,
                root_id: event.root_id,
                version: event.version,
                destination_topic_id: event.destination_topic_id,
            });
            self.history(id, Page::Latest, None);
        }
        // Move proves event coverage without settling a send or emitting Message state.
        self.merge_event(id, Vec::new(), source, Some(event.seq));
    }
    pub fn merge(&mut self, id: Uuid, records: Vec<Message>, source: Source) {
        self.merge_event(id, records, source, None);
    }
    pub fn merge_event(
        &mut self,
        id: Uuid,
        records: Vec<Message>,
        source: Source,
        event_seq: Option<i64>,
    ) {
        let Some((accepted, positions)) = self.admit(id, records, source, event_seq) else {
            return;
        };
        self.emit_records(id, source, accepted);
        self.advance_cursor(id, source, &positions);
    }

    fn admit(
        &mut self,
        id: Uuid,
        records: Vec<Message>,
        source: Source,
        event_seq: Option<i64>,
    ) -> Option<(Vec<Message>, Vec<i64>)> {
        let valid: Vec<_> = records
            .into_iter()
            .filter(|m| m.channel_id == id)
            .map(|mut m| {
                if m.deleted {
                    m.body = None;
                    m.mentions = None;
                }
                m
            })
            .collect();
        if source == Source::Projection
            && valid.iter().all(|m| {
                !m.deleted
                    && m.version == m.created_seq
                    && self.core.channel(id).is_none_or(|c| {
                        c.messages
                            .iter()
                            .find(|held| held.id == m.id)
                            .is_none_or(|held| {
                                held.version > m.version
                                    || (!self.refresh_mentions && held.mentions == m.mentions)
                            })
                    })
            })
        {
            self.settle(id, &valid);
            return None;
        }
        let mut positions: Vec<_> = if source == Source::Ack {
            valid.iter().map(|m| m.created_seq).collect()
        } else {
            event_seq.into_iter().collect()
        };
        let mut accepted = Vec::new();
        let mut recovery = false;
        let mut incoming: BTreeMap<Uuid, Message> = BTreeMap::new();
        for m in &valid {
            if incoming
                .get(&m.id)
                .is_none_or(|held| m.version > held.version)
            {
                incoming.insert(m.id, m.clone());
            }
        }
        let mut incoming: Vec<_> = incoming.into_values().collect();
        incoming.sort_by_key(|m| m.created_seq);
        let refresh = self.refresh_mentions;
        let c = self.channel(id);
        let mut messages = None;
        for mut m in incoming {
            if c.moved_roots
                .get(&m.reply_root_id.unwrap_or(m.id))
                .is_some_and(|seq| m.version < *seq)
            {
                continue;
            }
            // An evicted root floor makes unheld stream or ACK state ambiguous.
            // Keep its position as a gap target until a covering event read hydrates it.
            if matches!(source, Source::Ack | Source::Stream)
                && m.version < c.retired_move_through
                && !c.messages.iter().any(|held| held.id == m.id)
            {
                let seq = if source == Source::Ack {
                    Some(m.created_seq)
                } else {
                    event_seq
                };
                if let Some(seq) = seq.filter(|seq| c.cursor.is_none_or(|cursor| *seq > cursor)) {
                    c.forgotten_through = Some(c.forgotten_through.unwrap_or(0).max(seq));
                    positions.retain(|position| *position != seq);
                }
                continue;
            }
            if m.version > m.created_seq || m.deleted {
                c.mutation_seq = c.mutation_seq.max(m.version);
            }
            if let Some((version, deleted, _)) = c.versions.get(&m.id) {
                if *version > m.version || (*deleted && !m.deleted) {
                    continue;
                }
            } else if !c.messages.iter().any(|held| held.id == m.id)
                && (c
                    .retired_through
                    .is_some_and(|through| m.created_seq <= through)
                    || c.retired_versions
                        .iter()
                        .any(|r| r.start <= m.created_seq && m.created_seq <= r.end))
                && (source == Source::Stream || source == Source::Ack)
            {
                recovery = true;
                continue;
            }
            // Creation-only state needs no retained floor once its body is evicted.
            if (m.deleted || m.version > m.created_seq)
                && c.versions.get(&m.id) != Some(&(m.version, m.deleted, m.created_seq))
            {
                Rc::make_mut(&mut c.versions).insert(m.id, (m.version, m.deleted, m.created_seq));
            }
            let position = c
                .messages
                .partition_point(|entry| entry.created_seq < m.created_seq);
            if let Some(held) = c.messages.get(position).filter(|entry| entry.id == m.id) {
                if held.version > m.version {
                    continue;
                }
                if held.version == m.version {
                    let mentions = m.mentions;
                    m = (**held).clone();
                    if !m.deleted {
                        m.mentions = mentions;
                    }
                }
                accepted.push(m.clone());
                if !refresh && same_message(held, &m) {
                    continue;
                }
            } else {
                accepted.push(m.clone());
                if source == Source::Projection {
                    continue;
                }
            }
            let result = messages.get_or_insert_with(|| (*c.messages).clone());
            let position = result.partition_point(|entry| entry.created_seq < m.created_seq);
            if result
                .get(position)
                .is_some_and(|entry| entry.created_seq == m.created_seq)
            {
                result[position] = Rc::new(m);
            } else {
                result.insert(position, Rc::new(m));
            }
        }
        if let Some(messages) = messages {
            c.messages = Rc::new(messages);
        }
        if source != Source::Projection
            && let Some(max) = positions.iter().copied().max()
            && (c.held_through.is_some() || c.cursor.is_none_or(|cursor| max > cursor))
        {
            c.held_through = Some(c.held_through.unwrap_or(0).max(max));
        }
        if c.messages.len() > MAIN_MESSAGE_LIMIT {
            let older = source == Source::Window
                && valid
                    .last()
                    .zip(c.messages.last())
                    .is_some_and(|(a, b)| a.created_seq < b.created_seq);
            let start = if older {
                0
            } else {
                c.messages.len() - MAIN_MESSAGE_LIMIT
            };
            c.messages = Rc::new(c.messages[start..start + MAIN_MESSAGE_LIMIT].to_vec());
            c.has_older = true;
        }
        self.cap_versions(id, TOTAL_MESSAGE_LIMIT);
        if recovery && self.channel(id).watched {
            // A snapshot started before this rejected state cannot satisfy its recovery.
            self.invalidate(id, false);
            self.history(id, Page::Latest, None);
        }
        self.settle(id, &valid);
        Some((accepted, positions))
    }

    fn emit_records(&mut self, id: Uuid, source: Source, mut accepted: Vec<Message>) {
        if source == Source::Projection {
            accepted.retain(|m| m.deleted || m.version > m.created_seq);
        }
        if !accepted.is_empty() {
            if let Some((_, records)) = self
                .out
                .records
                .iter_mut()
                .find(|(channel, _)| *channel == id)
            {
                for message in accepted {
                    if let Some(held) = records.iter_mut().find(|held| held.id == message.id) {
                        *held = message;
                    } else {
                        records.push(message);
                    }
                }
            } else {
                self.out.records.push((id, accepted));
            }
        }
    }

    fn advance_cursor(&mut self, id: Uuid, source: Source, positions: &[i64]) {
        if source == Source::Window || source == Source::Projection {
            return;
        }
        let c = self.channel(id);
        let mut ranges = (*c.advancing).clone();
        ranges.extend(
            positions
                .iter()
                .copied()
                .filter(|seq| c.cursor.is_none_or(|cursor| *seq > cursor))
                .map(|seq| Range {
                    start: seq,
                    end: seq,
                }),
        );
        let mut merged = coalesce(ranges);
        if (source == Source::Stream || source == Source::Events)
            && let Some(mut cursor) = c.cursor
            && cursor
                .checked_add(1)
                .is_some_and(|next| positions.contains(&next))
        {
            while merged
                .first()
                .is_some_and(|r| r.start <= cursor.saturating_add(1))
            {
                cursor = cursor.max(merged.remove(0).end);
            }
            c.cursor = Some(cursor);
        }
        if merged.len() > MAIN_MESSAGE_LIMIT {
            c.forgotten_through = Some(
                c.forgotten_through
                    .unwrap_or(0)
                    .max(merged.last().map_or(0, |r| r.end)),
            );
        }
        if c.forgotten_through
            .zip(c.cursor)
            .is_some_and(|(target, cursor)| cursor >= target)
        {
            c.forgotten_through = None;
        }
        merged.truncate(MAIN_MESSAGE_LIMIT);
        if *c.advancing != merged {
            c.advancing = Rc::new(merged);
        }
    }
}

/// Sorts by start and merges ranges that overlap or touch.
pub(super) fn coalesce(mut ranges: Vec<Range>) -> Vec<Range> {
    ranges.sort_by_key(|r| r.start);
    let mut merged: Vec<Range> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut()
            && range.start <= last.end.saturating_add(1)
        {
            last.end = last.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(start: i64, end: i64) -> Range {
        Range { start, end }
    }

    #[test]
    fn coalesce_merges_overlapping_and_touching_ranges_and_keeps_gaps() {
        assert_eq!(coalesce(Vec::new()), Vec::new());
        assert_eq!(coalesce(vec![r(1, 4), r(3, 6)]), vec![r(1, 6)]);
        assert_eq!(coalesce(vec![r(1, 9), r(2, 3)]), vec![r(1, 9)]);
        assert_eq!(coalesce(vec![r(1, 2), r(3, 3)]), vec![r(1, 3)]);
        assert_eq!(coalesce(vec![r(1, 2), r(4, 4)]), vec![r(1, 2), r(4, 4)]);
        assert_eq!(
            coalesce(vec![r(10, 10), r(1, 1), r(5, 6), r(2, 2), r(7, 7)]),
            vec![r(1, 2), r(5, 7), r(10, 10)]
        );
        assert_eq!(
            coalesce(vec![r(i64::MAX, i64::MAX), r(i64::MAX - 1, i64::MAX - 1)]),
            vec![r(i64::MAX - 1, i64::MAX)]
        );
        assert_eq!(
            coalesce(vec![r(i64::MAX, i64::MAX), r(i64::MAX - 2, i64::MAX - 2)]),
            vec![r(i64::MAX - 2, i64::MAX - 2), r(i64::MAX, i64::MAX)]
        );
    }

    #[test]
    fn coalesce_merges_overlap_after_maximum_end() {
        assert_eq!(
            coalesce(vec![r(i64::MAX - 1, i64::MAX), r(i64::MAX, i64::MAX)]),
            vec![r(i64::MAX - 1, i64::MAX)]
        );
    }

    #[test]
    fn merge_event_advances_to_maximum_cursor_and_handles_duplicates() {
        for source in [Source::Stream, Source::Events] {
            let channel = Uuid::from_u128(1);
            let mut core = Core::new(Uuid::from_u128(2));
            let mut step = Step::new(&mut core);
            step.channel(channel).cursor = Some(i64::MAX - 2);

            step.merge_event(channel, Vec::new(), source, Some(i64::MAX));
            assert_eq!(step.channel(channel).cursor, Some(i64::MAX - 2));
            step.merge_event(channel, Vec::new(), source, Some(i64::MAX - 1));
            assert_eq!(step.channel(channel).cursor, Some(i64::MAX));
            assert!(step.channel(channel).advancing.is_empty());

            step.merge_event(channel, Vec::new(), source, Some(i64::MAX));
            assert_eq!(step.channel(channel).cursor, Some(i64::MAX));
            assert!(step.channel(channel).advancing.is_empty());
        }
    }
}
