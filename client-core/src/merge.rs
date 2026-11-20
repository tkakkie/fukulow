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

fn same_message(a: &Message, b: &Message) -> bool {
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
    pub fn settle(&mut self, id: Uuid, records: &[Message]) {
        let self_id = self.core.session.self_id;
        let settled: Vec<_> = records
            .iter()
            .filter(|m| m.channel_id == id && m.sender == self_id)
            .map(|m| m.client_message_id)
            .collect();
        let pending = self.channel(id).pending.clone();
        if pending
            .iter()
            .any(|p| settled.contains(&p.client_message_id))
        {
            for p in pending
                .iter()
                .filter(|p| settled.contains(&p.client_message_id))
            {
                self.cancel(p.retry_wait);
            }
            self.channel(id).pending = Rc::new(
                pending
                    .iter()
                    .filter(|p| !settled.contains(&p.client_message_id))
                    .cloned()
                    .collect(),
            );
        }
    }
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
            return;
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
        ranges.sort_by_key(|r| r.start);
        let mut merged: Vec<Range> = Vec::new();
        for range in ranges {
            if let Some(last) = merged.last_mut()
                && range.start <= last.end + 1
            {
                last.end = last.end.max(range.end);
            } else {
                merged.push(range);
            }
        }
        if (source == Source::Stream || source == Source::Events)
            && let Some(mut cursor) = c.cursor
            && positions.contains(&(cursor + 1))
        {
            while merged.first().is_some_and(|r| r.start <= cursor + 1) {
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
    pub(crate) fn cap_moved_roots(&mut self, id: Uuid, limit: usize) {
        let c = self.channel(id);
        if c.moved_roots.len() <= limit {
            return;
        }
        let roots = Rc::make_mut(&mut c.moved_roots);
        while roots.len() > limit {
            let Some((&root, &seq)) = roots.iter().min_by_key(|(_, seq)| *seq) else {
                break;
            };
            roots.remove(&root);
            c.retired_move_through = c.retired_move_through.max(seq);
        }
    }
    pub(crate) fn cap_versions(&mut self, id: Uuid, limit: usize) {
        let c = self.channel(id);
        let mut retired = Vec::new();
        while c.versions.len() > limit {
            let oldest = c
                .versions
                .iter()
                .min_by_key(|(id, (version, _, _))| (*version, **id))
                .map(|(id, value)| (*id, *value));
            if let Some((key, (_, _, created_seq))) = oldest {
                Rc::make_mut(&mut c.versions).remove(&key);
                retired.push(Range {
                    start: created_seq,
                    end: created_seq,
                });
            }
        }
        if !retired.is_empty() {
            let ranges = Rc::make_mut(&mut c.retired_versions);
            ranges.extend(retired);
            ranges.sort_by_key(|r| r.start);
            let mut merged: Vec<Range> = Vec::new();
            for range in ranges.drain(..) {
                if let Some(last) = merged.last_mut()
                    && range.start <= last.end + 1
                {
                    last.end = last.end.max(range.end);
                } else {
                    merged.push(range);
                }
            }
            let overflow = merged.len() > MAIN_MESSAGE_LIMIT;
            if overflow || c.retired_through.is_some() {
                c.retired_through = Some(
                    c.retired_through
                        .unwrap_or(0)
                        .max(merged.last().map_or(0, |r| r.end)),
                );
                *ranges = Vec::new();
                if overflow {
                    c.messages = Rc::default();
                    c.has_older = true;
                }
            } else {
                *ranges = merged;
            }
            let recover_window = overflow || c.latest.is_some();
            self.invalidate(id, false);
            let epoch = self.token();
            self.channel(id).version_epoch = epoch;
            if recover_window && self.channel(id).watched {
                self.history(id, Page::Latest, None);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::responses::HistoryPage;
    use serde_json::json;

    #[test]
    fn retired_move_floor_fences_ack_and_delivers_unrelated_create_from_covering_gap_page() {
        let channel = Uuid::from_u128(1);
        let root = Uuid::from_u128(2);
        let destination = Uuid::from_u128(3);
        let mut core = Core::new(Uuid::from_u128(4));
        core.session.connected = true;
        let mut step = Step::new(&mut core);
        let c = step.channel(channel);
        c.watched = true;
        c.cursor = Some(7);
        c.subscription = Some(Rc::new(Subscription {
            id: 0,
            after: 7,
            confirmed: true,
            watermark: 7,
        }));
        step.history(channel, Page::After, Some(7));
        let stale_request = step.channel(channel).fill.unwrap();
        for (root_id, seq) in [(root, 10), (Uuid::from_u128(5), 11)] {
            step.merge_move(
                serde_json::from_value(json!({
                    "type":"message","kind":"move","history_generation":Uuid::nil(),
                    "channel_id":channel,"seq":seq,"version":seq,"root_id":root_id,
                    "source_topic_id":null,"destination_topic_id":destination,"operation_id":root_id
                }))
                .unwrap(),
                Source::Stream,
            );
        }
        step.cap_moved_roots(channel, 1);
        let c = step.channel(channel);
        assert_eq!(c.retired_move_through, 10);
        assert!(!c.moved_roots.contains_key(&root));

        let stale: Message = serde_json::from_value(json!({
            "history_generation":Uuid::nil(),"channel_id":channel,"id":Uuid::from_u128(6),
            "created_seq":9,"version":9,"deleted":false,"client_message_id":Uuid::from_u128(7),
            "sender":Uuid::from_u128(8),"body":"reply","created_at":"2026-01-01T00:00:00Z",
            "topic_id":null,"reply_to":root,"reply_root_id":root,"mentions":[]
        }))
        .unwrap();
        step.merge(channel, vec![stale.clone()], Source::Ack);
        assert!(step.channel(channel).messages.is_empty());
        assert!(step.out.records.is_empty());

        let unrelated = Message {
            id: Uuid::from_u128(9),
            client_message_id: Uuid::from_u128(10),
            created_seq: 8,
            version: 8,
            reply_to: None,
            reply_root_id: None,
            ..stale.clone()
        };
        step.merge_event(channel, vec![unrelated.clone()], Source::Stream, Some(8));
        assert_eq!(step.channel(channel).cursor, Some(7));
        assert!(step.out.records.is_empty());

        let page = |messages: [Message; 2]| {
            Ok(HistoryPage::Events(fukulow_api::ChannelEventPage {
                history_generation: Uuid::nil(),
                events: messages
                    .into_iter()
                    .map(|message| fukulow_api::ServerEvent::Message {
                        seq: message.created_seq,
                        kind: fukulow_api::MessageStateKind::Create,
                        message,
                    })
                    .collect(),
                has_more: true,
            }))
        };
        step.history_response(stale_request, page([unrelated.clone(), stale.clone()]));
        assert_eq!(step.channel(channel).cursor, Some(7));
        assert!(step.out.records.is_empty());
        let moved = Message {
            version: 10,
            topic_id: Some(destination),
            ..stale
        };
        let request = step.channel(channel).fill.unwrap();
        assert_ne!(stale_request, request);
        step.history_response(request, page([unrelated.clone(), moved.clone()]));
        assert_eq!(step.channel(channel).cursor, Some(11));
        let delivered = &step.out.records[0].1;
        assert_eq!(delivered.len(), 2);
        assert!(same_message(&delivered[0], &unrelated));
        assert!(same_message(&delivered[1], &moved));
    }
}
