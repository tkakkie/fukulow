//! Typed bridge output. Borrow payload fields until the boundary encoder runs.
use crate::*;
use fukulow_api::{Mention, Message};
use serde::Serialize;
use std::{collections::HashMap, rc::Rc};

#[derive(Default)]
struct Bodies<'a> {
    indices: HashMap<&'a str, usize>,
    text: Vec<&'a str>,
}

impl<'a> Bodies<'a> {
    fn intern(&mut self, body: &'a str) -> usize {
        *self.indices.entry(body).or_insert_with(|| {
            self.text.push(body);
            self.text.len() - 1
        })
    }
}

#[derive(Serialize)]
struct MessageDelta<'a> {
    history_generation: Uuid,
    id: Uuid,
    channel_id: Uuid,
    created_seq: i64,
    version: i64,
    deleted: bool,
    client_message_id: Uuid,
    sender: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<usize>,
    created_at: &'a str,
    topic_id: Option<Uuid>,
    reply_to: Option<Uuid>,
    reply_root_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mentions: Option<&'a [Mention]>,
}

impl<'a> MessageDelta<'a> {
    fn new(message: &'a Message, bodies: &mut Bodies<'a>) -> Self {
        let Message {
            history_generation,
            id,
            channel_id,
            created_seq,
            version,
            deleted,
            client_message_id,
            sender,
            body,
            created_at,
            topic_id,
            reply_to,
            reply_root_id,
            mentions,
        } = message;
        Self {
            history_generation: *history_generation,
            id: *id,
            channel_id: *channel_id,
            created_seq: *created_seq,
            version: *version,
            deleted: *deleted,
            client_message_id: *client_message_id,
            sender: *sender,
            body: body.as_deref().map(|body| bodies.intern(body)),
            created_at,
            topic_id: *topic_id,
            reply_to: *reply_to,
            reply_root_id: *reply_root_id,
            mentions: mentions.as_deref(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingDelta<'a> {
    client_message_id: Uuid,
    body: usize,
    state: PendingState,
    request: Token,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_wait: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_code: Option<&'a str>,
    #[serde(rename = "reply_to", skip_serializing_if = "Option::is_none")]
    reply_to: Option<Uuid>,
    #[serde(rename = "topic_name", skip_serializing_if = "Option::is_none")]
    topic_name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_root_id: Option<Uuid>,
}

impl<'a> PendingDelta<'a> {
    fn new(pending: &'a Pending, bodies: &mut Bodies<'a>) -> Self {
        let Pending {
            client_message_id,
            body,
            state,
            request,
            retry_wait,
            failure_code,
            reply_to,
            topic_name,
            reply_root_id,
        } = pending;
        Self {
            client_message_id: *client_message_id,
            body: bodies.intern(body),
            state: *state,
            request: *request,
            retry_wait: *retry_wait,
            failure_code: failure_code.as_deref(),
            reply_to: *reply_to,
            topic_name: topic_name.as_deref(),
            reply_root_id: *reply_root_id,
        }
    }
}

#[derive(Serialize)]
#[serde(untagged)]
enum Entry<T> {
    Previous(usize),
    New(T),
}

#[derive(Serialize)]
struct SendDelta<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    history_generation: Option<Uuid>,
    id: Token,
    channel: Uuid,
    client_message_id: Uuid,
    body: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_to: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    topic_name: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum EffectDelta<'a> {
    Send(SendDelta<'a>),
    Other(&'a Effect),
}

impl<'a> EffectDelta<'a> {
    fn new(effect: &'a Effect, bodies: &mut Bodies<'a>) -> Self {
        match effect {
            Effect::Send {
                history_generation,
                id,
                channel,
                client_message_id,
                body,
                reply_to,
                topic_name,
            } => Self::Send(SendDelta {
                kind: "send",
                history_generation: *history_generation,
                id: *id,
                channel: *channel,
                client_message_id: *client_message_id,
                body: bodies.intern(body),
                reply_to: *reply_to,
                topic_name: topic_name.as_deref(),
            }),
            _ => Self::Other(effect),
        }
    }
}

// A splice covers append, trim and replacement. Offsets address the old
// array, so positions are independent of the lengths of earlier insertions.
#[derive(Serialize)]
struct Splice<'a> {
    start: usize,
    delete: usize,
    insert: Vec<MessageDelta<'a>>,
}

fn splices<'a>(
    old: &[Rc<Message>],
    new: &'a [Rc<Message>],
    bodies: &mut Bodies<'a>,
) -> Vec<Splice<'a>> {
    let mut ops = Vec::new();
    let (mut from, mut to, mut old_pos) = (0, 0, 0);
    // Creation positions are strictly increasing. Shared handles mark the
    // unchanged runs between splices, even when the window has shifted.
    for (new_pos, message) in new.iter().enumerate() {
        while old
            .get(old_pos)
            .is_some_and(|m| m.created_seq < message.created_seq)
        {
            old_pos += 1;
        }
        if old.get(old_pos).is_some_and(|m| Rc::ptr_eq(m, message)) {
            push_splice(&mut ops, from, old_pos, &new[to..new_pos], bodies);
            old_pos += 1;
            from = old_pos;
            to = new_pos + 1;
        }
    }
    push_splice(&mut ops, from, old.len(), &new[to..], bodies);
    ops
}

fn push_splice<'a>(
    ops: &mut Vec<Splice<'a>>,
    from: usize,
    end: usize,
    inserted: &'a [Rc<Message>],
    bodies: &mut Bodies<'a>,
) {
    if from != end || !inserted.is_empty() {
        ops.push(Splice {
            start: from,
            delete: end - from,
            insert: inserted
                .iter()
                .map(|m| MessageDelta::new(m, bodies))
                .collect(),
        });
    }
}

#[derive(Serialize)]
struct ChannelPatch<'a> {
    #[serde(with = "ChannelMetadata")]
    metadata: &'a ChannelView,
    #[serde(skip_serializing_if = "Option::is_none")]
    splices: Option<Vec<Splice<'a>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending: Option<Vec<Entry<PendingDelta<'a>>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    advancing: Option<&'a [Range]>,
}

impl<'a> ChannelPatch<'a> {
    fn new(old: Option<&ChannelView>, new: &'a ChannelView, bodies: &mut Bodies<'a>) -> Self {
        let changed_messages = old.is_none_or(|c| !Rc::ptr_eq(&c.messages, &new.messages));
        let old_messages = old.map_or(&[][..], |c| c.messages.as_slice());
        let pending = old
            .filter(|c| Rc::ptr_eq(&c.pending, &new.pending))
            .is_none()
            .then(|| {
                let prior: HashMap<_, _> = old
                    .into_iter()
                    .flat_map(|c| c.pending.iter().enumerate())
                    .map(|(index, p)| (p.client_message_id, (index, p)))
                    .collect();
                new.pending
                    .iter()
                    .map(|p| {
                        if let Some(&(index, previous)) = prior.get(&p.client_message_id)
                            && previous == p
                        {
                            return Entry::Previous(index);
                        }
                        Entry::New(PendingDelta::new(p, bodies))
                    })
                    .collect()
            });
        Self {
            metadata: new,
            splices: changed_messages.then(|| splices(old_messages, &new.messages, bodies)),
            pending,
            advancing: old
                .is_none_or(|c| !Rc::ptr_eq(&c.advancing, &new.advancing))
                .then_some(new.advancing.as_slice()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepDelta<'a> {
    changed_channels: &'a [Uuid],
    effects: Vec<EffectDelta<'a>>,
    records: Vec<(Uuid, Vec<MessageDelta<'a>>)>,
    #[serde(skip_serializing_if = "<[_]>::is_empty")]
    moves: &'a [MoveVersion],
    state_changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<&'a SessionView>,
    channels: BTreeMap<Uuid, Option<ChannelPatch<'a>>>,
    bodies: Vec<&'a str>,
}

pub(crate) struct Boundary {
    pub(crate) core: Core,
    // Shared handles from the previous step identify unchanged views and Messages.
    previous: BTreeMap<Uuid, ChannelView>,
}

impl Boundary {
    pub(crate) fn new(id: Uuid) -> Self {
        Self {
            core: Core::new(id),
            previous: BTreeMap::new(),
        }
    }

    pub(crate) fn step(&mut self, input: StepInput) -> serde_json::Result<String> {
        let session = self.core.session().clone();
        let result = self.core.step(input);
        let session_changed = session != *self.core.session();
        let json = serde_json::to_string(&self.delta(&result, session_changed));

        for &id in &result.changed_channels {
            match self.core.channel(id) {
                Some(view) => {
                    self.previous.insert(id, view.clone());
                }
                None => {
                    self.previous.remove(&id);
                }
            }
        }
        json
    }

    fn delta<'a>(&'a self, result: &'a StepResult, session_changed: bool) -> StepDelta<'a> {
        // Exhaustive so a new StepResult field cannot be dropped silently.
        let StepResult {
            effects,
            changed_channels,
            records,
            moves,
            state_changed,
        } = result;
        let mut bodies = Bodies::default();
        let effects = effects
            .iter()
            .map(|e| EffectDelta::new(e, &mut bodies))
            .collect();
        let records = records
            .iter()
            .map(|(id, messages)| {
                (
                    *id,
                    messages
                        .iter()
                        .map(|m| MessageDelta::new(m, &mut bodies))
                        .collect(),
                )
            })
            .collect();
        let channels = changed_channels
            .iter()
            .map(|&id| {
                let patch = self
                    .core
                    .channel(id)
                    .map(|new| ChannelPatch::new(self.previous.get(&id), new, &mut bodies));
                (id, patch)
            })
            .collect();
        StepDelta {
            changed_channels,
            effects,
            records,
            moves,
            state_changed: *state_changed,
            session: session_changed.then(|| self.core.session()),
            channels,
            bodies: bodies.text,
        }
    }
}

#[derive(Serialize)]
#[serde(remote = "ChannelView", rename_all = "camelCase")]
struct ChannelMetadata {
    state: Availability,
    watched: bool,
    cursor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot_seq: Option<i64>,
    mutation_seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    move_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    move_epoch: Option<Token>,
    versions: Rc<std::collections::BTreeMap<Uuid, (i64, bool, i64)>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retired_through: Option<i64>,
    retired_versions: Rc<Vec<Range>>,
    version_epoch: Token,
    has_older: bool,
    history_error: bool,
    fill_attempt: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    held_through: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    forgotten_through: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_used: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retained_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_base: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    older: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fill: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    wait: Option<Token>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription: Option<Rc<Subscription>>,
}

#[cfg(test)]
mod tests;
