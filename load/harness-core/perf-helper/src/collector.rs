use crate::counters::{CPU_COUNT, groups, pmu_type, sweep, text, tsc, tsc_sweep};
use crate::protocol::{check_delta, commands};
use serde_json::{Value, json};
use std::{
    env,
    io::{self, BufRead, Write},
    thread,
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn identity(pmu: u32) -> Result<Value> {
    let online = text("/sys/devices/system/cpu/online")?;
    if online != "0-15" || text("/proc/sys/kernel/perf_event_paranoid")? != "4" {
        return Err("expected CPUs 0–15 online and perf_event_paranoid=4".into());
    }
    let topology = (0..CPU_COUNT).map(|cpu| {
        let dir = format!("/sys/devices/system/cpu/cpu{cpu}/topology");
        Ok(json!({"cpu": cpu, "package": text(&format!("{dir}/physical_package_id"))?,
            "core": text(&format!("{dir}/core_id"))?, "siblings": text(&format!("{dir}/thread_siblings_list"))?}))
    }).collect::<io::Result<Vec<_>>>()?;
    Ok(
        json!({"bootId": text("/proc/sys/kernel/random/boot_id")?, "kernel": text("/proc/sys/kernel/osrelease")?,
        "version": env!("CARGO_PKG_VERSION"), "pmuType": pmu, "online": online, "topology": topology}),
    )
}

fn emit(record: Value) -> Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &record)?;
    writeln!(out)?;
    out.flush()?;
    Ok(())
}

fn invariant_tsc() -> Result<()> {
    let info = text("/proc/cpuinfo")?;
    let flags: Vec<_> = info
        .lines()
        .filter_map(|line| {
            let (key, flags) = line.split_once(':')?;
            (key.trim() == "flags").then_some(flags)
        })
        .collect();
    if flags.len() != CPU_COUNT
        || !flags.iter().all(|flags| {
            ["constant_tsc", "nonstop_tsc", "aperfmperf"]
                .iter()
                .all(|needed| flags.split_whitespace().any(|f| f == *needed))
        })
    {
        return Err("invariant TSC or APERF/MPERF support missing".into());
    }
    Ok(())
}

pub fn run() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    let pmu = pmu_type()?;
    let host = identity(pmu)?;
    match args.as_slice() {
        [arg] if arg == "--check" => {
            let mut groups = groups(pmu)?;
            let open = sweep(&mut groups)?;
            thread::sleep(Duration::from_secs(1));
            let close = sweep(&mut groups)?;
            for (before, after) in open.iter().zip(&close) {
                check_delta(before, after)?;
            }
            emit(json!({"mode": "check", "identity": host, "open": open, "close": close}))
        }
        [arg] if arg == "calibrate" => {
            invariant_tsc()?;
            let mut events = tsc(pmu)?;
            let open = tsc_sweep(&mut events)?;
            thread::sleep(Duration::from_secs(1));
            let close = tsc_sweep(&mut events)?;
            emit(json!({"identity": host, "open": open, "close": close}))
        }
        [mode, session, block]
            if matches!(mode.as_str(), "block" | "control")
                && !session.is_empty()
                && session.len() <= 64
                && session
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-') =>
        {
            let order = block.parse::<u8>()?;
            if !(1..=6).contains(&order) {
                return Err("invalid block number".into());
            }
            let mut groups = groups(pmu)?;
            emit(json!({"ready": true}))?;
            let mut input = io::stdin().lock().lines();
            for phase in commands(mode == "control") {
                if input.next().transpose()?.as_deref() != Some(phase) {
                    return Err(format!("expected {phase}").into());
                }
                let reads = sweep(&mut groups)?;
                emit(
                    json!({"phase": phase, "identity": host, "launchSession": session, "order": order, "reads": reads}),
                )?;
            }
            Ok(())
        }
        _ => Err(
            "usage: fukulow-perf-helper --check | calibrate | (block|control) SESSION ORDER".into(),
        ),
    }
}
