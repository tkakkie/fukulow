#![cfg(test)]

use std::process::Command;

#[test]
fn startup_rejects_empty_setup_token_but_accepts_unset_or_nonempty() {
    let mut database_errors = Vec::new();
    for setup_token in [None, Some(""), Some("setup-token-test-only")] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fukulow-server"));
        // An invalid URL makes reaching database configuration fail immediately.
        command
            .env("DATABASE_URL", "invalid-test-url")
            .env("FUKULOW_COOKIE_SECURE", "true")
            .env_remove("FUKULOW_SETUP_TOKEN");
        if let Some(setup_token) = setup_token {
            command.env("FUKULOW_SETUP_TOKEN", setup_token);
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8(output.stderr).unwrap();
        if setup_token == Some("") {
            assert!(
                error.contains("FUKULOW_SETUP_TOKEN must not be empty"),
                "{error}"
            );
        } else {
            assert!(!error.contains("FUKULOW_SETUP_TOKEN"), "{error}");
            assert!(!error.is_empty());
            database_errors.push(error);
        }
    }
    assert_eq!(database_errors[0], database_errors[1]);
}

#[test]
fn startup_rejects_partial_or_invalid_proxy_configuration_before_database_access() {
    for (peers, header, expected) in [
        (Some("192.0.2.1"), None, "configure FUKULOW_TRUSTED_PROXIES"),
        (
            None,
            Some("x-forwarded-for"),
            "configure FUKULOW_TRUSTED_PROXIES",
        ),
        (
            Some(""),
            Some("x-forwarded-for"),
            "FUKULOW_TRUSTED_PROXIES must contain",
        ),
        (
            Some("192.0.2.1"),
            Some("bad header"),
            "FUKULOW_CLIENT_IP_HEADER must be",
        ),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fukulow-server"));
        command
            .env("DATABASE_URL", "invalid-test-url")
            .env_remove("FUKULOW_SETUP_TOKEN")
            .env_remove("FUKULOW_TRUSTED_PROXIES")
            .env_remove("FUKULOW_CLIENT_IP_HEADER");
        if let Some(peers) = peers {
            command.env("FUKULOW_TRUSTED_PROXIES", peers);
        }
        if let Some(header) = header {
            command.env("FUKULOW_CLIENT_IP_HEADER", header);
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(error.contains(expected), "{error}");
    }
}

#[test]
fn startup_rejects_invalid_websocket_origins_before_database_access() {
    for origins in [
        "",
        "*",
        "https://chat.example/path",
        "https://chat.example:99999",
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_fukulow-server"))
            .env("DATABASE_URL", "invalid-test-url")
            .env_remove("FUKULOW_SETUP_TOKEN")
            .env("FUKULOW_WS_ALLOWED_ORIGINS", origins)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("FUKULOW_WS_ALLOWED_ORIGINS")
        );
    }
}
