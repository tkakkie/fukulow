#![cfg(test)]

use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::{Command, Output, Stdio},
};

const BINARY: &str = env!("CARGO_BIN_EXE_fukulow-server");
const PIN: &str =
    "0.1.0-rc.1@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const EXISTS: &str =
    "Error: \".env already exists; use it or run init in a different directory\"\n";

struct WorkDir(PathBuf);

impl WorkDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("fukulow-init-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(BINARY);
        command.env_clear().current_dir(&self.0).arg("init");
        command
    }

    fn env_path(&self) -> PathBuf {
        self.0.join(".env")
    }

    fn assert_settings(&self, proxy: &str, domain: &str) {
        let path = self.env_path();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let contents = fs::read_to_string(path).unwrap();
        let mut lines = contents.lines();
        for (key, value) in [
            ("FUKULOW_VERSION", PIN),
            ("COMPOSE_PROFILES", proxy),
            ("FUKULOW_DOMAIN", domain),
        ] {
            assert!(
                lines
                    .next()
                    .is_some_and(|line| line == format!("{key}={value}"))
            );
        }
        let [setup, owner, app] = [
            "FUKULOW_SETUP_TOKEN=",
            "POSTGRES_PASSWORD=",
            "POSTGRES_APP_PASSWORD=",
        ]
        .map(|key| {
            let value = lines
                .next()
                .unwrap()
                .strip_prefix(key)
                .expect("credential key missing");
            assert!(
                value.len() == 64
                    && value
                        .bytes()
                        .all(|byte| b"0123456789abcdef".contains(&byte))
            );
            value
        });
        assert!(setup != owner && setup != app && owner != app);
        assert!(lines.next().is_none() && contents.ends_with('\n'));
        assert_eq!(fs::read_dir(&self.0).unwrap().count(), 1);
    }
}

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_refused(output: Output, diagnostic: &str) {
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(String::from_utf8(output.stderr).unwrap(), diagnostic);
}

#[test]
fn init_writes_private_distinct_secrets() {
    for (umask, options, proxy, domain) in [
        ("000", vec![], "caddy", "localhost"),
        (
            "777",
            vec!["--proxy", "nginx", "--domain", "chat.example.com"],
            "nginx",
            "chat.example.com",
        ),
        ("022", vec!["--proxy", "none"], "none", "localhost"),
    ] {
        let dir = WorkDir::new();
        let output = Command::new("/bin/sh")
            .env_clear()
            .current_dir(&dir.0)
            .args([
                "-c",
                "umask \"$1\"; shift; exec \"$@\"",
                "init-test",
                umask,
                BINARY,
                "init",
                "--version",
                PIN,
            ])
            .args(options)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stdout.is_empty() && output.stderr.is_empty());
        dir.assert_settings(proxy, domain);
    }
}

#[test]
fn init_preserves_existing_paths_and_serializes_publication() {
    let dir = WorkDir::new();
    let path = dir.env_path();
    fs::write(&path, b"existing-test-only-content").unwrap();
    assert_refused(
        dir.command().args(["--version", PIN]).output().unwrap(),
        EXISTS,
    );
    assert!(fs::read(&path).unwrap() == b"existing-test-only-content");
    fs::remove_file(&path).unwrap();

    let absent = dir.0.join("absent-target");
    symlink(&absent, &path).unwrap();
    assert_refused(
        dir.command().args(["--version", PIN]).output().unwrap(),
        EXISTS,
    );
    assert_eq!(fs::read_link(&path).unwrap(), absent);
    assert!(!absent.exists());
    fs::remove_file(path).unwrap();

    let children: Vec<_> = (0..8)
        .map(|_| {
            dir.command()
                .args(["--version", PIN])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    let mut successes = 0;
    for child in children {
        let output = child.wait_with_output().unwrap();
        if output.status.success() {
            successes += 1;
            assert!(output.stdout.is_empty() && output.stderr.is_empty());
        } else {
            assert_refused(output, EXISTS);
        }
    }
    assert_eq!(successes, 1);
    dir.assert_settings("caddy", "localhost");
}

#[test]
fn init_rejects_invalid_arguments_without_echoing_values() {
    let dir = WorkDir::new();
    for (args, diagnostic) in [
        (
            vec![],
            "Pass --version to the release's FUKULOW_VERSION (TAG@sha256: followed by 64 lowercase hex digits)",
        ),
        (
            vec!["--version", "invalid-image-test-only"],
            "Pass --version to the release's FUKULOW_VERSION (TAG@sha256: followed by 64 lowercase hex digits)",
        ),
        (
            vec![
                "--version",
                PIN,
                "--domain",
                "test-only\nPOSTGRES_PASSWORD=injected",
            ],
            "Pass --domain to a DNS hostname such as chat.example.com",
        ),
        (
            vec!["--version", PIN, "--proxy", "invalid-profile-test-only"],
            "Pass --proxy to caddy, nginx or none",
        ),
    ] {
        assert_refused(
            dir.command().args(args).output().unwrap(),
            &format!("Error: {diagnostic:?}\n"),
        );
    }
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
}
