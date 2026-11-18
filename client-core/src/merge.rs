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
        kind: fukulow_api::ChannelEventKind,
        seq: i64,
        message: &Message,
    ) -> bool {
        !matches!(kind, fukulow_api::ChannelEventKind::Create) || message.created_seq == seq
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
        let positions: Vec<_> = if source == Source::Ack {
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
