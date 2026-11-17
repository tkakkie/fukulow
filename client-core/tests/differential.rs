use fukulow_client_core::{Core, StepInput};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeSet, error::Error, fs, path::PathBuf};
use uuid::Uuid;

#[derive(Deserialize)]
struct TraceStep {
    trace: String,
    input: usize,
    expected: usize,
}

#[derive(Deserialize)]
struct Contract {
    values: Vec<Value>,
    steps: Vec<TraceStep>,
}

// Container children index earlier values; scalars are literal JSON. The shared table
// losslessly stores the original TS oracle, including metadata and effect ordering.
fn expand(values: &[Value], index: usize) -> Result<Value, Box<dyn Error>> {
    let value = values.get(index).ok_or("missing contract value")?;
    let child = |v: &Value| -> Result<Value, Box<dyn Error>> {
        let id = usize::try_from(v.as_u64().ok_or("invalid contract reference")?)?;
        if id >= index {
            return Err("contract references must point to earlier values".into());
        }
        expand(values, id)
    };
    Ok(match value {
        Value::Array(items) => Value::Array(items.iter().map(child).collect::<Result<_, _>>()?),
        Value::Object(items) => Value::Object(
            items
                .iter()
                .map(|(k, v)| Ok((k.clone(), child(v)?)))
                .collect::<Result<_, Box<dyn Error>>>()?,
        ),
        scalar => scalar.clone(),
    })
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
fn recorded_fixtures_and_seeded_sequences_match_every_step() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let contract: Contract = serde_json::from_str(&fs::read_to_string(
        root.join("contract/realtime/core-traces.json"),
    )?)?;
    let mut trace_count = 0;
    let mut current_trace = String::new();
    let mut core = Core::new(Uuid::nil());
    let mut channels = BTreeSet::new();
    let mut tokens = BTreeSet::new();
    let mut index = 0;
    let mut count = 0;
    let mut counts = std::collections::BTreeMap::new();
    for step in contract.steps {
        let expected = expand(&contract.values, step.expected)?;
        let raw_input = expand(&contract.values, step.input)?;
        *counts.entry(step.trace.clone()).or_insert(0) += 1;
        if step.trace != current_trace {
            let initial: Uuid = serde_json::from_value(expected["session"]["selfId"].clone())?;
            core = Core::new(initial);
            current_trace = step.trace;
            channels.clear();
            tokens.clear();
            index = 0;
            trace_count += 1;
        }
        index += 1;
        let input: StepInput = serde_json::from_value(raw_input.clone())?;
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
        let mismatch = difference(&observed, &expected, "step");
        assert!(
            mismatch.is_none(),
            "{} step {} input {}: {}",
            current_trace,
            index,
            raw_input,
            mismatch.unwrap_or_default()
        );
        count += 1;
    }
    assert_eq!(trace_count, 66);
    assert_eq!(count, 9170);
    assert_eq!(
        counts.get("retention-ranges-and-reference-identity"),
        Some(&923)
    );
    for (seed, steps) in [(1_u64, 1907), (42, 1907), (464, 1907), (0xdeadbeef, 1911)] {
        assert_eq!(counts.get(&format!("generated-{seed}")), Some(&steps));
    }
    println!(
        "Matched {trace_count} recorded contract traces, {count} steps ({} core fixtures, retention/identity, four seeds)",
        trace_count - 5
    );
    Ok(())
}
