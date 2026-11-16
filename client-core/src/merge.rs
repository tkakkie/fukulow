use crate::{engine::Step, *};
use fukulow_api::Message;
use std::{collections::BTreeMap, rc::Rc};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Source {
    Window,
    Ack,
    Stream,
}
fn same_message(a: &Message, b: &Message) -> bool {
    a.id == b.id
        && a.channel_id == b.channel_id
        && a.seq == b.seq
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
    pub fn merge(&mut self, id: Uuid, records: Vec<Message>, source: Source) {
        let valid: Vec<_> = records.into_iter().filter(|m| m.channel_id == id).collect();
        if !valid.is_empty() {
            if let Some((_, r)) = self.out.records.iter_mut().find(|(key, _)| *key == id) {
                *r = valid.clone();
            } else {
                self.out.records.push((id, valid.clone()));
            }
        }
        let incoming: BTreeMap<_, _> = valid.iter().map(|m| (m.seq, m)).collect();
        let refresh = self.refresh_mentions;
        let c = self.channel(id);
        let mut messages = None;
        for m in incoming.values() {
            let position = c.messages.partition_point(|entry| entry.seq < m.seq);
            if c.messages
                .get(position)
                .is_some_and(|entry| entry.seq == m.seq && !refresh && same_message(entry, m))
            {
                continue;
            }
            let result = messages.get_or_insert_with(|| (*c.messages).clone());
            let position = result.partition_point(|entry| entry.seq < m.seq);
            if result.get(position).is_some_and(|entry| entry.seq == m.seq) {
                result[position] = Rc::new((*m).clone());
            } else {
                result.insert(position, Rc::new((*m).clone()));
            }
        }
        if let Some(messages) = messages {
            c.messages = Rc::new(messages);
        }
        if let Some(max) = valid.iter().map(|m| m.seq).max() {
            c.held_through = Some(c.held_through.unwrap_or(0).max(max));
        }
        if c.messages.len() > MAIN_MESSAGE_LIMIT {
            let older = source == Source::Window
                && valid
                    .last()
                    .zip(c.messages.last())
                    .is_some_and(|(a, b)| a.seq < b.seq);
            let start = if older {
                0
            } else {
                c.messages.len() - MAIN_MESSAGE_LIMIT
            };
            c.messages = Rc::new(c.messages[start..start + MAIN_MESSAGE_LIMIT].to_vec());
            c.has_older = true;
        }
        self.settle(id, &valid);
        if source == Source::Window {
            return;
        }
        let c = self.channel(id);
        let mut ranges = (*c.advancing).clone();
        ranges.extend(
            valid
                .iter()
                .filter(|m| c.cursor.is_none_or(|cursor| m.seq > cursor))
                .map(|m| Range {
                    start: m.seq,
                    end: m.seq,
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
        if source == Source::Stream
            && let Some(mut cursor) = c.cursor
            && valid.iter().any(|m| m.seq == cursor + 1)
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
}
