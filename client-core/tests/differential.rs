use fukulow_client_core::{Core, StepInput};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    error::Error,
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::Command,
};
use uuid::Uuid;

#[derive(Deserialize)]
struct TraceStep {
    trace: String,
    input: Value,
    expected: Value,
}

fn difference(actual: &Value, expected: &Value, path: &str) -> Option<String> {
    if actual == expected {
        return None;
    }
    match (actual, expected) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
                if let Some(found) =
                    difference(&actual[key], &expected[key], &format!("{path}.{key}"))
                {
                    return Some(found);
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (index, (a, b)) in a.iter().zip(b).enumerate() {
                if let Some(found) = difference(a, b, &format!("{path}[{index}]")) {
                    return Some(found);
                }
            }
        }
        _ => {}
    }
    Some(format!("{path}: actual {actual}, expected {expected}"))
}

#[test]
fn comparison_rejects_missing_metadata_state_and_changed_effect_order() {
    let expected = json!({"effects":[{"type":"close"},{"type":"sign_in"}],"changedChannels":["A"],
        "records":[["A",[]]],"stateChanged":true,"channels":{"A":{"cursor":0}},
        "session":{"running":true},"requests":{},"timers":{}});
    for key in expected.as_object().into_iter().flat_map(|map| map.keys()) {
        let mut actual = expected.clone();
        actual.as_object_mut().map(|map| map.remove(key));
        assert!(difference(&actual, &expected, "step").is_some(), "{key}");
    }
    let mut reordered = expected.clone();
    reordered["effects"] = json!([{"type":"sign_in"},{"type":"close"}]);
    assert!(difference(&reordered, &expected, "step").is_some());
    assert!(difference(&expected, &expected, "step").is_none());
}

#[test]
fn live_typescript_fixtures_and_seeded_sequences_match_every_step() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let path =
        std::env::temp_dir().join(format!("fukulow-core-traces-{}.jsonl", std::process::id()));
    let output = Command::new("npm")
        .current_dir(&root)
        .args([
            "--prefix",
            "web",
            "test",
            "--",
            "src/client-core-traces.test.ts",
        ])
        .env("CLIENT_CORE_TRACE_FILE", &path)
        .output()?;
    assert!(
        output.status.success(),
        "TS reference failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let mut trace_count = 0;
    let mut current_trace = String::new();
    let mut core = Core::new(Uuid::nil());
    let mut channels = BTreeSet::new();
    let mut tokens = BTreeSet::new();
    let mut index = 0;
    let mut count = 0;
    // Read one step at a time: neither test process needs all Channel snapshots in memory.
    for line in BufReader::new(fs::File::open(&path)?).lines() {
        let step: TraceStep = serde_json::from_str(&line?)?;
        if step.trace != current_trace {
            let initial: Uuid = serde_json::from_value(step.expected["session"]["selfId"].clone())?;
            core = Core::new(initial);
            current_trace = step.trace;
            channels.clear();
            tokens.clear();
            index = 0;
            trace_count += 1;
        }
        index += 1;
        let input: StepInput = serde_json::from_value(step.input.clone())?;
        let result = core.step(input);
        for id in &result.changed_channels {
            channels.insert(*id);
        }
        for effect in &result.effects {
            if let Some(token) = serde_json::to_value(effect)?["id"].as_i64() {
                tokens.insert(token);
            }
        }
        let mut observed = serde_json::to_value(result)?;
        observed["session"] = serde_json::to_value(core.session())?;
        observed["channels"] = json!({});
        observed["requests"] = json!({});
        observed["timers"] = json!({});
        for id in &channels {
            if let Some(channel) = core.channel(*id) {
                observed["channels"][id.to_string()] = serde_json::to_value(channel)?;
            }
        }
        for token in &tokens {
            if let Some(request) = core.request(*token) {
                observed["requests"][token.to_string()] = serde_json::to_value(request)?;
            }
            if let Some(timer) = core.timer(*token) {
                observed["timers"][token.to_string()] = serde_json::to_value(timer)?;
            }
        }
        let mismatch = difference(&observed, &step.expected, "step");
        assert!(
            mismatch.is_none(),
            "{} step {} input {}: {}",
            current_trace,
            index,
            step.input,
            mismatch.unwrap_or_default()
        );
        count += 1;
    }
    fs::remove_file(path)?;
    assert!(trace_count > 4);
    assert!(count > 6000);
    println!(
        "Matched {trace_count} live TS traces, {count} steps ({} core fixtures, retention/identity, four seeds)",
        trace_count - 5
    );
    Ok(())
}
