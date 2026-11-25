use super::super::{ChannelEvent, Message, log};
use axum::extract::ws::Utf8Bytes;

/// One canonical payload and wire frame shared by every live recipient.
#[derive(serde::Serialize)]
#[serde(transparent)]
pub(crate) struct LiveMessage {
    event: ChannelEvent,
    #[serde(skip)]
    pub frame: Utf8Bytes,
}

impl std::ops::Deref for LiveMessage {
    type Target = ChannelEvent;

    fn deref(&self) -> &ChannelEvent {
        &self.event
    }
}

impl LiveMessage {
    #[cfg(test)]
    pub(crate) fn new(message: Message) -> Result<Self, serde_json::Error> {
        Self::from_event(ChannelEvent::create(message))
    }

    pub(crate) fn from_event(event: ChannelEvent) -> Result<Self, serde_json::Error> {
        // Messages cannot depend on realtime. Keep this borrowed wire envelope
        // byte-compatible with ServerEvent::Message (guarded by the raw-frame test).
        #[derive(serde::Serialize)]
        #[serde(tag = "type", rename_all = "snake_case")]
        enum Event<'a> {
            Message {
                seq: i64,
                kind: fukulow_api::MessageStateKind,
                message: &'a Message,
            },
        }
        let frame = match &event.payload {
            log::Payload::Create(message) => serde_json::to_string(&Event::Message {
                seq: event.seq,
                kind: fukulow_api::MessageStateKind::Create,
                message,
            }),
            log::Payload::Move(event) => serde_json::to_string(event),
        }?
        .into();
        Ok(Self { event, frame })
    }
}
