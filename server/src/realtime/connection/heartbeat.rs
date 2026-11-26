use super::Lifecycle;
use tokio::time::{Instant, Interval, MissedTickBehavior};

pub(super) struct Heartbeat {
    lifecycle: Lifecycle,
    ping_sent_at: Option<Instant>,
    next_ping: Instant,
    interval: Interval,
}

impl Heartbeat {
    pub(super) fn new(lifecycle: Lifecycle) -> Self {
        let next_ping = Instant::now() + lifecycle.ping_interval;
        let mut interval = tokio::time::interval_at(next_ping, lifecycle.ping_interval);
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        Self {
            lifecycle,
            ping_sent_at: None,
            next_ping,
            interval,
        }
    }

    pub(super) async fn tick(&mut self) {
        self.interval.tick().await;
    }

    pub(super) fn idle_expired(&self) -> bool {
        self.ping_sent_at
            .is_some_and(|sent| sent.elapsed() >= self.lifecycle.idle_timeout)
    }

    pub(super) fn ping_sent(&mut self) {
        let sent = Instant::now();
        // Replay/live work can delay a tick. Grace starts only after a Ping.
        let first_ping = *self.ping_sent_at.get_or_insert(sent);
        self.next_ping = sent + self.lifecycle.ping_interval;
        self.interval
            .reset_at(self.next_ping.min(first_ping + self.lifecycle.idle_timeout));
    }

    pub(super) fn frame_received(&mut self) {
        self.ping_sent_at = None;
        self.interval.reset_at(self.next_ping);
    }
}
