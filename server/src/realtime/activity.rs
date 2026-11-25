use super::{ServerEvent, connection::Connection};
use crate::{
    channels::activity::NoticeFrame,
    observability::{REVOCATION_MEASUREMENT_TARGET, measurement_ms},
};
use axum::extract::ws::WebSocket;

impl Connection<'_> {
    pub(super) async fn activity_notice(
        pool: &sqlx::PgPool,
        socket: &mut WebSocket,
        notice: NoticeFrame,
    ) -> Result<(), u16> {
        let mut sent = None;
        let timing = &mut sent;
        if let Some(result) = notice
            .handoff(pool, |notice| async move {
                let event = ServerEvent::from(notice);
                let frame = Self::event_frame(&event)?;
                // A buffered write can span polls. Bound it from entry through successful flush.
                let started = if let ServerEvent::ChannelAccessRevoked { channel_id } = event
                    && tracing::event_enabled!(target: REVOCATION_MEASUREMENT_TARGET, tracing::Level::TRACE)
                {
                    Some((channel_id, measurement_ms()))
                } else {
                    None
                };
                Self::send(socket, frame).await?;
                *timing = started.map(|(channel_id, before_ms)| (channel_id, before_ms, measurement_ms()));
                Ok::<(), u16>(())
            })
            .await
        {
            result?;
        }
        // Keep log I/O outside the gate that protects the first write poll.
        if let Some((channel_id, before_ms, after_ms)) = sent {
            tracing::trace!(
                target: REVOCATION_MEASUREMENT_TARGET,
                event = "channel_access_revoked_sent",
                %channel_id,
                before_ms,
                after_ms,
                after_hold = notice.is_held_retry()
            );
        }
        Ok(())
    }
}

impl From<crate::channels::activity::Notice> for ServerEvent {
    fn from(notice: crate::channels::activity::Notice) -> Self {
        use crate::channels::activity::Notice;
        match notice {
            Notice::ActivityReady => Self::ActivityReady,
            Notice::ActivityReset => Self::ActivityReset,
            Notice::ChannelActivity { channel_id, seq } => {
                Self::ChannelActivity { channel_id, seq }
            }
            Notice::ReadPositionChanged {
                channel_id,
                topic_id,
                read_seq,
            } => Self::ReadPositionChanged {
                channel_id,
                topic_id,
                read_seq,
            },
            Notice::ChannelAccessGained { channel_id } => Self::ChannelAccessGained { channel_id },
            Notice::ChannelAccessRevoked { channel_id } => {
                Self::ChannelAccessRevoked { channel_id }
            }
            Notice::ChannelListChanged => Self::ChannelListChanged,
            Notice::DmListChanged => Self::DmListChanged,
            Notice::SectionsChanged { generation } => Self::SectionsChanged {
                generation: generation.to_string(),
            },
            Notice::ChannelMembersChanged { channel_id } => {
                Self::ChannelMembersChanged { channel_id }
            }
            Notice::MembersChanged => Self::MembersChanged,
        }
    }
}
