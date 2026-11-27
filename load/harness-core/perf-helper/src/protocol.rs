use serde_json::Value;
#[cfg(test)]
use serde_json::json;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

// #519 F2's four-by-four Williams square is the largest plan; the load tests check all plans.
const MAX_BLOCK_ORDER: u8 = 16;

pub fn block_order(arg: &str) -> Result<u8> {
    let order = arg.parse::<u8>()?;
    if !(1..=MAX_BLOCK_ORDER).contains(&order) {
        return Err("invalid block number".into());
    }
    Ok(order)
}

pub fn commands(control: bool) -> &'static [&'static str] {
    if control {
        &["open", "idle", "close"]
    } else {
        &["open", "close"]
    }
}

pub fn check_delta(before: &Value, after: &Value) -> Result<()> {
    let integer = |value: &Value, key| -> Result<u64> {
        Ok(value[key].as_str().ok_or("missing perf field")?.parse()?)
    };
    let delta = |key| -> Result<u64> {
        integer(after, key)?
            .checked_sub(integer(before, key)?)
            .ok_or("counter reset".into())
    };
    let enabled = delta("enabled")?;
    let raw_span = delta("rawNs")?;
    if delta("monoNs")? < 999_000_000
        || raw_span == 0
        || enabled == 0
        || enabled.abs_diff(raw_span) > 1_000_000
        || enabled != delta("running")?
        || [before, after].iter().any(|r| r["enabled"] != r["running"])
        || before["aperfId"] != after["aperfId"]
        || before["mperfId"] != after["mperfId"]
        || (delta("aperf")? == 0) != (delta("mperf")? == 0)
    {
        return Err("incomplete counting interval".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_order_accepts_only_the_planned_range() {
        assert_eq!(block_order("1").unwrap(), 1);
        assert_eq!(
            block_order(&MAX_BLOCK_ORDER.to_string()).unwrap(),
            MAX_BLOCK_ORDER
        );
        assert!(block_order("0").is_err());
        assert!(block_order(&(MAX_BLOCK_ORDER + 1).to_string()).is_err());
        assert!(block_order("not-a-number").is_err());
    }

    #[test]
    fn formal_has_exactly_two_reads_and_control_has_an_idle_sweep() {
        assert_eq!(commands(false), &["open", "close"]);
        assert_eq!(commands(true), &["open", "idle", "close"]);
    }

    #[test]
    fn check_rejects_counter_reset_and_lost_time() {
        let before = json!({"enabled":"20", "running":"20", "aperf":"4", "mperf":"4", "monoNs":"1000",
            "rawNs":"2000", "aperfId":"10", "mperfId":"11"});
        let after = |running, aperf, mperf| {
            json!({"enabled":"1000000020", "running":running, "aperf":aperf,
            "mperf":mperf, "monoNs":"1000001000", "rawNs":"1000002000", "aperfId":"10", "mperfId":"11"})
        };
        assert!(check_delta(&before, &after("1000000020", "4", "4")).is_ok());
        assert!(check_delta(&before, &after("1000000019", "5", "5")).is_err());
        assert!(check_delta(&before, &after("1000000020", "3", "3")).is_err());
        assert!(check_delta(&before, &after("1000000020", "5", "4")).is_err());
    }

    #[test]
    fn check_requires_counting_time_within_one_ms_of_raw_span() {
        let before = json!({"enabled":"0", "running":"0", "aperf":"4", "mperf":"4", "monoNs":"1000",
            "rawNs":"2000", "aperfId":"10", "mperfId":"11"});
        let mut after = json!({"enabled":"130000000000", "running":"130000000000", "aperf":"5", "mperf":"5",
            "monoNs":"130002001000", "rawNs":"130000002000", "aperfId":"10", "mperfId":"11"});
        assert!(check_delta(&before, &after).is_ok());

        for (counting, passes) in [
            ("129999000000", true),
            ("130001000000", true),
            ("129998999999", false),
            ("130001000001", false),
        ] {
            after["enabled"] = json!(counting);
            after["running"] = json!(counting);
            assert_eq!(check_delta(&before, &after).is_ok(), passes, "{counting}");
        }

        after["enabled"] = json!("130000000000");
        after["running"] = json!("130000000000");
        after.as_object_mut().unwrap().remove("rawNs");
        assert!(check_delta(&before, &after).is_err());
    }
}
