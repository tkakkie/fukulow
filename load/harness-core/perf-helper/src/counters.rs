use perf_event::{Builder, Counter, ReadFormat, events::Software};
use rustix::time::{ClockId, clock_gettime};
use serde_json::{Value, json};
use std::{fs, io};

pub const CPU_COUNT: usize = 16;
pub const MSR: &str = "/sys/bus/event_source/devices/msr";
const JITTER_NS: i128 = 1_000_000;

pub fn text(path: &str) -> io::Result<String> {
    let value = fs::read_to_string(path)?.trim().to_owned();
    if value.is_empty() {
        return Err(io::Error::other(format!("empty {path}")));
    }
    Ok(value)
}

fn missing(what: &str) -> io::Error {
    io::Error::other(format!("incomplete perf read: {what}"))
}

fn event_config(name: &str) -> io::Result<u64> {
    let field = text(&format!("{MSR}/events/{name}"))?;
    let hex = field
        .strip_prefix("event=0x")
        .ok_or_else(|| io::Error::other(format!("unexpected MSR encoding: {field}")))?;
    u64::from_str_radix(hex, 16).map_err(io::Error::other)
}

pub fn now(clock: ClockId) -> i128 {
    let t = clock_gettime(clock);
    i128::from(t.tv_sec) * 1_000_000_000 + i128::from(t.tv_nsec)
}

fn builder(cpu: usize, pmu: u32, config: u64, pinned: bool, group: bool) -> Builder<'static> {
    let mut b = Builder::new(Software::DUMMY);
    b.one_cpu(cpu)
        .any_pid()
        .exclude_user(false)
        .include_kernel()
        .include_hv()
        .pinned(pinned);
    let format = ReadFormat::ID | ReadFormat::TOTAL_TIME_ENABLED | ReadFormat::TOTAL_TIME_RUNNING;
    b.read_format(if group {
        format | ReadFormat::GROUP
    } else {
        format
    });
    b.attrs_mut().type_ = pmu;
    b.attrs_mut().config = config;
    b
}

pub fn pmu_type() -> io::Result<u32> {
    text(&format!("{MSR}/type"))?
        .parse()
        .map_err(io::Error::other)
}

pub fn groups(pmu: u32) -> io::Result<Vec<(Counter, Counter)>> {
    let aperf = event_config("aperf")?;
    let mperf = event_config("mperf")?;
    (0..CPU_COUNT)
        .map(|cpu| {
            let mut leader = builder(cpu, pmu, aperf, true, true).build()?;
            let member = builder(cpu, pmu, mperf, false, false)
                .enabled(true)
                .build_with_group(&mut leader)?;
            leader.enable_group()?;
            Ok((leader, member))
        })
        .collect()
}

pub fn sweep(groups: &mut [(Counter, Counter)]) -> io::Result<Vec<Value>> {
    groups.iter_mut().enumerate().map(|(cpu, (leader, member))| {
        let data = leader.read_group()?;
        let raw = now(ClockId::MonotonicRaw);
        let stamp = now(ClockId::Monotonic);
        if data.len() != 2 {
            return Err(missing("group size"));
        }
        let a = data.get(leader).ok_or_else(|| missing("APERF"))?;
        let m = data.get(member).ok_or_else(|| missing("MPERF"))?;
        let enabled = data.time_enabled().ok_or_else(|| missing("enabled time"))?;
        let running = data.time_running().ok_or_else(|| missing("running time"))?;
        Ok(json!({"cpu": cpu, "monoNs": stamp.to_string(), "rawNs": raw.to_string(),
            "aperfId": a.id().to_string(), "mperfId": m.id().to_string(),
            "aperf": a.value().to_string(), "mperf": m.value().to_string(), "enabled": enabled.as_nanos().to_string(),
            "running": running.as_nanos().to_string()}))
    }).collect()
}

pub fn tsc(pmu: u32) -> io::Result<Vec<Counter>> {
    let config = event_config("tsc")?;
    (0..CPU_COUNT)
        .map(|cpu| builder(cpu, pmu, config, true, false).enabled(true).build())
        .collect()
}

pub fn tsc_sweep(events: &mut [Counter]) -> io::Result<Vec<Value>> {
    events.iter_mut().enumerate().map(|(cpu, event)| {
        let before = now(ClockId::MonotonicRaw);
        let reading = event.read_count_and_time()?;
        let after = now(ClockId::MonotonicRaw);
        if !(0..=JITTER_NS).contains(&(after - before))
            || reading.time_running != reading.time_enabled || reading.time_running == 0 {
            return Err(missing("TSC bracket or running time"));
        }
        Ok(json!({"cpu": cpu, "id": event.id().to_string(), "count": reading.count.to_string(),
            "enabled": reading.time_enabled.to_string(), "running": reading.time_running.to_string(),
            "beforeNs": before.to_string(), "afterNs": after.to_string()}))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leader_uses_runtime_msr_pmu_group_format_with_no_exclusions() {
        let leader = builder(9, 41, 0x0a, true, true);
        let member = builder(9, 41, 0x0b, false, false);
        assert_eq!(leader.attrs().type_, 41);
        assert_eq!(leader.attrs().config, 0x0a);
        assert_eq!(member.attrs().config, 0x0b);
        assert_eq!(leader.attrs().pinned(), 1);
        assert_eq!(member.attrs().pinned(), 0);
        assert!(
            ReadFormat::from_bits_retain(leader.attrs().read_format).contains(ReadFormat::GROUP)
        );
        for b in [leader, member] {
            let a = b.attrs();
            assert_eq!(
                [
                    a.exclude_user(),
                    a.exclude_kernel(),
                    a.exclude_hv(),
                    a.exclude_idle(),
                    a.exclude_host(),
                    a.exclude_guest(),
                    a.exclude_callchain_kernel(),
                    a.exclude_callchain_user()
                ],
                [0; 8]
            );
        }
    }
}
