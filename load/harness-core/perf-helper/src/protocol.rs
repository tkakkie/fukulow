use serde_json::Value;
#[cfg(test)]
use serde_json::json;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

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
    let span = delta("monoNs")?;
    if span < 999_000_000
        || enabled.abs_diff(span) > 1_000_000
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
    fn formal_has_exactly_two_reads_and_control_has_an_idle_sweep() {
        assert_eq!(commands(false), &["open", "close"]);
        assert_eq!(commands(true), &["open", "idle", "close"]);
    }

    #[test]
    fn check_rejects_counter_reset_and_lost_time() {
        let before = json!({"enabled":"20", "running":"20", "aperf":"4", "mperf":"4", "monoNs":"1000",
            "aperfId":"10", "mperfId":"11"});
        let after = |running, aperf, mperf| {
            json!({"enabled":"1000000020", "running":running, "aperf":aperf,
            "mperf":mperf, "monoNs":"1000001000", "aperfId":"10", "mperfId":"11"})
        };
        assert!(check_delta(&before, &after("1000000020", "4", "4")).is_ok());
        assert!(check_delta(&before, &after("1000000019", "5", "5")).is_err());
        assert!(check_delta(&before, &after("1000000020", "3", "3")).is_err());
        assert!(check_delta(&before, &after("1000000020", "5", "4")).is_err());
    }
}
