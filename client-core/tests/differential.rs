use fukulow_client_core::{Core, StepInput};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    error::Error,
    fs,
    path::PathBuf,
};
use uuid::Uuid;

#[derive(Deserialize, Serialize)]
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
fn expansion_rejects_missing_values_self_forward_and_non_integer_references() {
    assert!(expand(&[Value::Null], 1).is_err());
    for reference in [
        json!(1),
        json!(2),
        json!(3),
        json!(-1),
        json!(0.5),
        json!("0"),
    ] {
        for node in [json!([reference]), json!({"child": reference})] {
            assert!(
                expand(&[Value::Null, node.clone(), Value::Null], 1).is_err(),
                "{node}"
            );
        }
    }
    assert_eq!(
        expand(&[Value::Null, json!([0])], 1).ok(),
        Some(json!([null]))
    );
}

// Retain existing node order/spelling to keep intentional updates reviewable. New
// nodes are interned bottom-up; unreachable old expectations are removed on write.
struct Recorder {
    values: Vec<Value>,
    lines: Vec<String>,
    ids: HashMap<String, usize>,
    steps: Vec<TraceStep>,
}

impl Recorder {
    fn new(contract: &Contract, source: &str) -> Result<Self, Box<dyn Error>> {
        let (_, table) = source
            .split_once("\"values\":[\n")
            .ok_or("missing value table")?;
        let (table, _) = table
            .split_once("\n],\n\"steps\":[\n")
            .ok_or("missing steps")?;
        let lines: Vec<_> = table
            .lines()
            .map(|line| line.trim_end_matches(',').to_owned())
            .collect();
        if lines.len() != contract.values.len() {
            return Err("expected one contract value per line".into());
        }
        let ids = contract
            .values
            .iter()
            .enumerate()
            .map(|(id, value)| Ok((serde_json::to_string(value)?, id)))
            .collect::<Result<_, serde_json::Error>>()?;
        Ok(Self {
            values: contract.values.clone(),
            lines,
            ids,
            steps: Vec::new(),
        })
    }

    fn intern(&mut self, value: &Value) -> Result<usize, Box<dyn Error>> {
        let encoded = match value {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .map(|v| self.intern(v).map(|id| json!(id)))
                    .collect::<Result<_, _>>()?,
            ),
            Value::Object(items) => Value::Object(
                items
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), json!(self.intern(v)?))))
                    .collect::<Result<_, Box<dyn Error>>>()?,
            ),
            scalar => scalar.clone(),
        };
        let key = serde_json::to_string(&encoded)?;
        if let Some(id) = self.ids.get(&key) {
            return Ok(*id);
        }
        let id = self.values.len();
        self.ids.insert(key.clone(), id);
        self.lines.push(key);
        self.values.push(encoded);
        Ok(id)
    }

    fn render(&self) -> Result<String, Box<dyn Error>> {
        let mut used = BTreeSet::new();
        let mut pending: Vec<_> = self
            .steps
            .iter()
            .flat_map(|s| [s.input, s.expected])
            .collect();
        while let Some(id) = pending.pop() {
            if !used.insert(id) {
                continue;
            }
            match &self.values[id] {
                Value::Array(items) => {
                    pending.extend(items.iter().filter_map(Value::as_u64).map(|id| id as usize))
                }
                Value::Object(items) => pending.extend(
                    items
                        .values()
                        .filter_map(Value::as_u64)
                        .map(|id| id as usize),
                ),
                _ => {}
            }
        }
        let remap: HashMap<_, _> = used
            .iter()
            .enumerate()
            .map(|(new, old)| (*old, new))
            .collect();
        let mut lines = Vec::new();
        for old in &used {
            let mut value = self.values[*old].clone();
            let children: Vec<_> = match &mut value {
                Value::Array(items) => items.iter_mut().collect(),
                Value::Object(items) => items.values_mut().collect(),
                _ => Vec::new(),
            };
            for child in children {
                let id = child.as_u64().ok_or("invalid recorded reference")? as usize;
                *child = json!(remap[&id]);
            }
            lines.push(if value == self.values[*old] {
                self.lines[*old].clone()
            } else {
                serde_json::to_string(&value)?
            });
        }
        let steps = self
            .steps
            .iter()
            .map(|s| {
                serde_json::to_string(&TraceStep {
                    trace: s.trace.clone(),
                    input: remap[&s.input],
                    expected: remap[&s.expected],
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(format!(
            "{{\n\"values\":[\n{}\n],\n\"steps\":[\n{}\n]\n}}\n",
            lines.join(",\n"),
            steps.join(",\n")
        ))
    }
}

#[test]
fn recorder_replaces_expectations_deduplicates_and_prunes_unused_values()
-> Result<(), Box<dyn Error>> {
    let source = "{\n\"values\":[\nnull,\n\"old\"\n],\n\"steps\":[\n]\n}\n";
    let contract = serde_json::from_str(source)?;
    let mut recorder = Recorder::new(&contract, source)?;
    let input = recorder.intern(&Value::Null)?;
    let expected = recorder.intern(&json!({"new": [true, true]}))?;
    assert_eq!(recorder.intern(&json!({"new": [true, true]}))?, expected);
    recorder.steps.push(TraceStep {
        trace: "updated".into(),
        input,
        expected,
    });
    let recorded: Contract = serde_json::from_str(&recorder.render()?)?;
    assert_eq!(recorded.values.len(), 4);
    assert!(!recorded.values.contains(&json!("old")));
    assert_eq!(
        expand(&recorded.values, recorded.steps[0].expected)?,
        json!({"new": [true, true]})
    );
    Ok(())
}

fn boundary_snapshot(core: &Core, channels: &BTreeSet<Uuid>) -> Result<Value, Box<dyn Error>> {
    let mut view = serde_json::to_value(core.session())?;
    view["channels"] = json!({});
    for id in channels {
        if let Some(channel) = core.channel(*id) {
            view["channels"][id.to_string()] = serde_json::to_value(channel)?;
        }
    }
    let mut requests = json!({});
    let mut timers = json!({});
    // Same bounded accessor probe as core-contract.test.ts.
    for id in 1..=9 {
        if let Some(request) = core.request(id) {
            requests[id.to_string()] = serde_json::to_value(request)?;
        }
        if let Some(timer) = core.timer(id) {
            timers[id.to_string()] = serde_json::to_value(timer)?;
        }
    }
    Ok(json!({"view": view, "requests": requests, "timers": timers}))
}

#[test]
fn recorded_boundary_matches_initial_and_every_step() -> Result<(), Box<dyn Error>> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../contract/realtime/core-boundary.json");
    let source = fs::read_to_string(&path)?;
    let contract: Value = serde_json::from_str(&source)?;
    let mut recorded = contract.clone();
    let mut core = Core::new(serde_json::from_value(contract["self"].clone())?);
    let mut channels = BTreeSet::new();
    recorded["initial"] = boundary_snapshot(&core, &channels)?;
    for step in recorded["steps"]
        .as_array_mut()
        .ok_or("missing boundary steps")?
    {
        let result = core.step(serde_json::from_value(step["input"].clone())?);
        channels.extend(&result.changed_channels);
        let mut expected = boundary_snapshot(&core, &channels)?;
        expected["result"] = serde_json::to_value(result)?;
        step["expected"] = expected;
    }
    if std::env::var("UPDATE_CONTRACT").as_deref() == Ok("1") {
        // Preserve the original field order/formatting when its values are unchanged.
        let output = if recorded == contract {
            source
        } else {
            format!("{}\n", serde_json::to_string_pretty(&recorded)?)
        };
        fs::write(path, output)?;
    } else {
        assert_eq!(difference(&recorded, &contract, "boundary"), None);
    }
    Ok(())
}

#[test]
fn recorded_fixtures_and_seeded_sequences_match_every_step() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let path = root.join("contract/realtime/core-traces.json");
    let source = fs::read_to_string(&path)?;
    let contract: Contract = serde_json::from_str(&source)?;
    let update = std::env::var("UPDATE_CONTRACT").as_deref() == Ok("1");
    let mut recorder = if update {
        Some(Recorder::new(&contract, &source)?)
    } else {
        None
    };
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
            current_trace = step.trace.clone();
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
        if let Some(recorder) = &mut recorder {
            // The former TS recorder distinguished object key orders. Preserve
            // those existing node identities when the JSON values still agree.
            let expected = if observed == expected {
                step.expected
            } else {
                recorder.intern(&observed)?
            };
            recorder.steps.push(TraceStep {
                trace: step.trace,
                input: step.input,
                expected,
            });
        } else {
            assert!(
                mismatch.is_none(),
                "{} step {} input {}: {}",
                current_trace,
                index,
                raw_input,
                mismatch.unwrap_or_default()
            );
        }
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
    if let Some(recorder) = recorder {
        fs::write(path, recorder.render()?)?;
    }
    println!(
        "Matched {trace_count} recorded contract traces, {count} steps ({} core fixtures, retention/identity, four seeds)",
        trace_count - 5
    );
    Ok(())
}
