#![cfg(test)]

use std::{fs, path::PathBuf, process::Command};

use serde_json::Value;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let fixture =
            Self(std::env::temp_dir().join(format!("fukulow-lints-{}", uuid::Uuid::new_v4())));
        fs::create_dir_all(fixture.0.join("server/src")).unwrap();
        fs::create_dir_all(fixture.0.join("server/tests")).unwrap();
        fs::copy(root.join("../Cargo.toml"), fixture.0.join("Cargo.toml")).unwrap();
        fs::copy(root.join("../clippy.toml"), fixture.0.join("clippy.toml")).unwrap();
        // Keep the real package header and lint inheritance, without compiling its
        // dependencies. Removing inheritance from the server must break this test.
        let manifest = fs::read_to_string(root.join("Cargo.toml")).unwrap();
        let (header, _) = manifest.split_once("\n[dependencies]").unwrap();
        fs::write(fixture.0.join("server/Cargo.toml"), header).unwrap();
        fs::write(fixture.0.join("server/src/main.rs"), "fn main() {}\n").unwrap();
        fixture
    }

    fn check(&self, source: &str, integration: &str) -> std::process::Output {
        fs::write(self.0.join("server/src/lib.rs"), source).unwrap();
        fs::write(self.0.join("server/tests/probe.rs"), integration).unwrap();
        Command::new(env!("CARGO"))
            .args([
                "clippy",
                "--offline",
                "--all-targets",
                "--message-format=json",
                "--",
                "-D",
                "warnings",
            ])
            .current_dir(&self.0)
            // Isolate nested Cargo from the outer build and from caller overrides.
            .env("CARGO_TARGET_DIR", self.0.join("target"))
            .env("CLIPPY_CONF_DIR", &self.0)
            .env_remove("RUSTFLAGS")
            .env_remove("CARGO_ENCODED_RUSTFLAGS")
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_denied(output: &std::process::Output, expected: &[&str]) {
    assert!(!output.status.success(), "invalid fixture passed Clippy");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let codes: Vec<String> = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|message| {
            message["message"]["code"]["code"]
                .as_str()
                .map(str::to_owned)
        })
        .collect();
    for code in expected {
        assert!(
            codes.iter().any(|actual| actual == code),
            "missing {code}: {stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn workspace_lints_reject_production_violations_and_allow_test_panics() {
    let fixture = Fixture::new();
    let output = fixture.check(
        r#"
pub fn unwrap(value: Option<u8>) -> u8 { value.unwrap() }
pub fn expect(value: Option<u8>) -> u8 { value.expect("required") }
pub fn panic() { panic!("production panic"); }
pub unsafe fn forbidden() {}
"#,
        "",
    );
    assert_denied(
        &output,
        &[
            "clippy::unwrap_used",
            "clippy::expect_used",
            "clippy::panic",
            "unsafe_code",
        ],
    );

    let helpers = r#"
fn unwrap(value: Option<u8>) -> u8 { value.unwrap() }
fn expect(value: Option<u8>) -> u8 { value.expect("required") }
fn panic() { panic!("test panic"); }
#[test]
fn helpers_are_allowed() {
    assert_eq!(unwrap(Some(1)), expect(Some(1)));
    let _ = panic as fn();
}
"#;
    let output = fixture.check(
        &format!("#[cfg(test)] mod tests {{ {helpers} }}"),
        &format!("#![cfg(test)]\n{helpers}"),
    );
    assert!(
        output.status.success(),
        "test helpers rejected: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    // Unlike panicking helpers, unsafe remains forbidden even inside test code.
    let output = fixture.check(
        "#[cfg(test)] mod tests { pub unsafe fn forbidden() {} }",
        "#![cfg(test)]\npub unsafe fn forbidden() {}",
    );
    assert_denied(&output, &["unsafe_code"]);

    // `forbid`, unlike `deny`, cannot be relaxed by an inner attribute.
    let output = fixture.check(
        "#[allow(unsafe_code)] pub unsafe fn cannot_override_forbid() {}",
        "",
    );
    assert_denied(&output, &["E0453"]);
}
