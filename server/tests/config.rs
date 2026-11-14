#![cfg(test)]

use std::process::Command;

#[test]
fn startup_database_diagnostics_never_echo_sensitive_inputs() {
    for args in [vec![], vec!["migrate"], vec!["migrate", "roles"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_fukulow-server"))
            .env_clear()
            .args(args)
            .env("DATABASE_URL", "secret-invalid-database-url")
            .env("FUKULOW_SETUP_TOKEN", "secret-setup-value")
            .env("POSTGRES_APP_PASSWORD", "secret-role-value")
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(!error.contains("secret-"), "{error}");
        assert!(error.contains("database_failure"), "{error}");
        assert!(error.contains("diagnostics suppressed"), "{error}");
    }
}

#[test]
fn roles_command_requires_password_before_connecting_and_rejects_unknown_commands() {
    for password in [None, Some("")] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fukulow-server"));
        command.env_clear().args(["migrate", "roles"]);
        if let Some(password) = password {
            command.env("POSTGRES_APP_PASSWORD", password);
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("POSTGRES_APP_PASSWORD must")
        );
        assert!(output.stdout.is_empty());
    }
    for args in [
        vec!["unknown"],
        vec!["migrate", "unknown"],
        vec!["migrate", "roles", "unknown"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_fukulow-server"))
            .env_clear()
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8(output.stderr).unwrap().contains("Usage:"));
    }
}

#[test]
fn startup_requires_setup_token_regardless_of_cookie_security() {
    for cookie_secure in [None, Some("true"), Some("false")] {
        for setup_token in [
            None,
            Some(""),
            Some(" \t\n"),
            Some("\u{2003}"),
            Some("setup-token-local-test-only"),
            Some(" setup-token-local-test-only\t"),
            Some("setup-token-test-only"),
            Some(" custom-setup-token-test-only "),
        ] {
            let mut command = Command::new(env!("CARGO_BIN_EXE_fukulow-server"));
            command.env_clear().env("DATABASE_URL", "invalid-test-url");
            if let Some(value) = cookie_secure {
                command.env("FUKULOW_COOKIE_SECURE", value);
            }
            if let Some(value) = setup_token {
                command.env("FUKULOW_SETUP_TOKEN", value);
            }
            let output = command.output().unwrap();
            assert!(!output.status.success());
            let error = String::from_utf8(output.stderr).unwrap();
            if matches!(
                setup_token,
                Some("setup-token-test-only" | " custom-setup-token-test-only ")
            ) {
                assert!(!error.contains("FUKULOW_SETUP_TOKEN"), "{error}");
                assert!(!error.is_empty());
            } else {
                assert!(error.contains("FUKULOW_SETUP_TOKEN must"), "{error}");
            }
            assert!(!error.contains("setup-token-test-only"));
            assert!(!error.contains("setup-token-local-test-only"));
            assert!(!error.contains("custom-setup-token-test-only"));
            assert!(output.stdout.is_empty());
        }
    }
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
        (
            Some("192.0.2.0/33"),
            Some("x-forwarded-for"),
            "FUKULOW_TRUSTED_PROXIES must contain",
        ),
        (
            Some("2001:db8::/129"),
            Some("x-forwarded-for"),
            "FUKULOW_TRUSTED_PROXIES must contain",
        ),
        (
            Some("192.0.2.0/+24"),
            Some("x-forwarded-for"),
            "FUKULOW_TRUSTED_PROXIES must contain",
        ),
        (
            Some("192.0.2.0/024"),
            Some("x-forwarded-for"),
            "FUKULOW_TRUSTED_PROXIES must contain",
        ),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fukulow-server"));
        command
            .env_clear()
            .env("DATABASE_URL", "invalid-test-url")
            .env("FUKULOW_SETUP_TOKEN", "setup-token-test-only")
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
            .env_clear()
            .env("DATABASE_URL", "invalid-test-url")
            .env("FUKULOW_SETUP_TOKEN", "setup-token-test-only")
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

#[test]
fn startup_rejects_invalid_pool_configuration_before_database_access() {
    for (name, values) in [
        (
            "FUKULOW_DB_MAX_CONNECTIONS",
            vec!["", "0", "1", "2", "-1", "3.5", "4294967296", "invalid"],
        ),
        (
            "FUKULOW_DB_ACQUIRE_TIMEOUT_MS",
            vec![
                "",
                "0",
                "-1",
                "1.5",
                "5001",
                "18446744073709551616",
                "invalid",
            ],
        ),
    ] {
        for value in values {
            let output = Command::new(env!("CARGO_BIN_EXE_fukulow-server"))
                .env_clear()
                .env("FUKULOW_SETUP_TOKEN", "setup-token-test-only")
                .env("DATABASE_URL", "invalid-test-url")
                .env(name, value)
                .output()
                .unwrap();
            assert!(!output.status.success());
            let error = String::from_utf8(output.stderr).unwrap();
            assert!(error.contains(name), "{error}");
            assert!(!error.contains("panicked"), "{error}");
            assert!(output.stdout.is_empty());
        }
    }
}
