//! Message sync timer delay policy.
use crate::Purpose;

fn backoff_cap(attempt: u64) -> f64 {
    f64::from((500_u32 << attempt.min(5)).min(10_000))
}

/// `draw_or_ms` is the reconnect draw in [0, 1), the supplied grace or retry
/// duration in milliseconds, or unused for fill backoff.
pub fn sync_delay(purpose: Purpose, attempt: u64, draw_or_ms: f64) -> f64 {
    match purpose {
        Purpose::ReconnectBackoff => (draw_or_ms * backoff_cap(attempt)).floor(),
        Purpose::FillBackoff => backoff_cap(attempt),
        Purpose::ReorderGrace | Purpose::SendRetry => draw_or_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_backoff_is_deterministic_at_attempt_boundaries() {
        for (attempt, expected) in [
            (0, 500.0),
            (1, 1_000.0),
            (2, 2_000.0),
            (3, 4_000.0),
            (4, 8_000.0),
            (5, 10_000.0),
            (6, 10_000.0),
            (u64::MAX, 10_000.0),
        ] {
            for draw in [0.0, 0.25, 1.0 - f64::EPSILON / 2.0] {
                assert_eq!(sync_delay(Purpose::FillBackoff, attempt, draw), expected);
            }
        }
    }

    #[test]
    fn backoff_matches_the_previous_typescript_formulas() {
        for attempt in [0, 1, 2, 3, 4, 5, 6, 31, 32, 100, u64::MAX] {
            let cap = (500.0 * 2_f64.powf((attempt as f64).min(5.0))).min(10_000.0);
            assert_eq!(sync_delay(Purpose::FillBackoff, attempt, 0.0), cap);
            for draw in [
                0.0,
                f64::from_bits(1),
                0.001,
                0.125,
                0.25,
                0.999_999,
                1.0 - f64::EPSILON / 2.0,
            ] {
                let delay = sync_delay(Purpose::ReconnectBackoff, attempt, draw);
                assert_eq!(
                    delay,
                    (draw * cap).floor(),
                    "attempt {attempt}, draw {draw}"
                );
                assert!((0.0..cap).contains(&delay));
            }
        }
    }

    #[test]
    fn reorder_grace_preserves_the_configured_duration() {
        for ms in [0.0, 40.5, 100.0] {
            assert_eq!(sync_delay(Purpose::ReorderGrace, 0, ms), ms);
        }
    }

    #[test]
    fn send_retry_preserves_delays_past_the_browser_timer_limit() {
        for ms in [0.0, 3_000.0, 2_147_483_648.0, 9_007_199_254_740_991.0] {
            assert_eq!(sync_delay(Purpose::SendRetry, 0, ms), ms);
        }
    }
}
