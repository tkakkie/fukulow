use crate::{
    INACTIVE_CHANNEL_LIMIT, INACTIVE_CHANNEL_MESSAGE_LIMIT, MAIN_MESSAGE_LIMIT, Page, Range,
    SYNC_MESSAGE_LIMIT, engine::Step, merge::coalesce,
};
use std::rc::Rc;
use uuid::Uuid;

impl Step<'_> {
    fn trim(&mut self, id: Uuid, limit: usize) {
        let c = self.channel(id);
        c.messages = Rc::new(c.messages[c.messages.len().saturating_sub(limit)..].to_vec());
        c.retained_count = Some(c.messages.len());
        c.has_older = true;
    }
    pub(super) fn retention(&mut self) {
        for (id, before) in &self.touched {
            let changed = before
                .as_ref()
                .zip(self.core.channel(*id))
                .is_none_or(|(a, b)| !Rc::ptr_eq(&a.messages, &b.messages));
            if changed && let Some(c) = self.core.channels.get_mut(id) {
                c.retained_count = Some(c.messages.len());
            }
        }
        let mut inactive: Vec<_> = self
            .core
            .channel_order
            .iter()
            .filter_map(|id| {
                self.core
                    .channel(*id)
                    .filter(|c| !c.watched)
                    .map(|c| (*id, c.last_used.unwrap_or(0)))
            })
            .collect();
        inactive.sort_by_key(|a| std::cmp::Reverse(a.1));
        for (index, (id, _)) in inactive.into_iter().enumerate() {
            let limit = if index < INACTIVE_CHANNEL_LIMIT {
                INACTIVE_CHANNEL_MESSAGE_LIMIT
            } else {
                0
            };
            if self
                .core
                .channel(id)
                .is_some_and(|c| c.versions.len() > limit)
            {
                self.cap_versions(id, limit);
            }
            if self
                .core
                .channel(id)
                .is_some_and(|c| c.moved_roots.len() > limit)
            {
                self.cap_moved_roots(id, limit);
            }
            if self
                .core
                .channel(id)
                .is_some_and(|c| c.retained_count.unwrap_or(0) > limit)
            {
                self.trim(id, limit);
            }
        }
        let mut priority: Vec<_> = self
            .core
            .channel_order
            .iter()
            .filter_map(|id| {
                self.core
                    .channel(*id)
                    .map(|c| (*id, c.watched, c.last_used.unwrap_or(0)))
            })
            .collect();
        priority.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
        let mut remaining = SYNC_MESSAGE_LIMIT;
        for (id, _, _) in priority {
            if self
                .core
                .channel(id)
                .is_some_and(|c| c.retained_count.unwrap_or(0) > remaining)
            {
                self.trim(id, remaining);
            }
            remaining -= self
                .core
                .channel(id)
                .and_then(|c| c.retained_count)
                .unwrap_or(0);
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
            let merged = coalesce(std::mem::take(ranges));
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
    use crate::{
        Core, Subscription,
        merge::{Source, same_message},
        responses::HistoryPage,
        test_support::message as message_fixture,
    };
    use fukulow_api::Message;
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

        let mut reply = message_fixture(9, 9);
        reply["channel_id"] = json!(channel);
        reply["id"] = json!(Uuid::from_u128(6));
        reply["client_message_id"] = json!(Uuid::from_u128(7));
        reply["sender"] = json!(Uuid::from_u128(8));
        reply["body"] = json!("reply");
        reply["reply_to"] = json!(root);
        reply["reply_root_id"] = json!(root);
        reply["mentions"] = json!([]);
        let stale: Message = serde_json::from_value(reply).unwrap();
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
