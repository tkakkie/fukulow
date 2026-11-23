#![cfg(test)]

use std::{
    ffi::OsStr,
    os::unix::ffi::OsStrExt,
    process::{Command, Output},
};

#[path = "support/pools.rs"]
mod test_support;

const INVALID_UTF8: &[u8] = b"secret-config-test-only\xff";

fn server_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_fukulow-server"));
    command
        .env_clear()
        .env("FUKULOW_SETUP_TOKEN", "secret-setup-value");
    command
}

fn assert_config_error(output: Output, diagnostic: &str) {
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        format!("Error: {diagnostic:?}\n")
    );
}

#[test]
fn startup_panics_never_echo_payloads_or_secrets() {
    let output = Command::new(env!("CARGO_BIN_EXE_fukulow-server"))
        .env_clear()
        .env(
            "TOKIO_WORKER_THREADS",
            "postgres://user:secret-startup-password@localhost/db",
        )
        .env("RUST_BACKTRACE", "full")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    for forbidden in [
        "secret-",
        "postgres://",
        "TOKIO_WORKER_THREADS",
        "panicked",
        "invalid digit",
    ] {
        assert!(!stderr.contains(forbidden), "{stderr}");
    }
    let event: serde_json::Value = serde_json::from_str(stderr.trim()).unwrap();
    assert_eq!(
        event,
        serde_json::json!({"level":"ERROR", "target":"fukulow", "fields":{"event":"panic"}})
    );
}

#[sqlx::test(migrations = false)]
async fn migrate_command_preserves_missing_role_instruction_and_suppresses_database_errors(
    pool: sqlx::PgPool,
) {
    use sqlx::ConnectOptions;
    // Shadow only this database's catalog lookup, without changing cluster-global
    // roles used by parallel tests. The executable still performs the real query.
    sqlx::raw_sql("CREATE VIEW public.pg_roles AS SELECT NULL::name AS rolname WHERE false")
        .execute(&pool)
        .await
        .unwrap();
    let mut database_url = pool.connect_options().to_url_lossy();
    database_url
        .query_pairs_mut()
        .append_pair("options", "-c search_path=public,pg_catalog");
    let run = || {
        Command::new(env!("CARGO_BIN_EXE_fukulow-server"))
            .env_clear()
            .arg("migrate")
            .env("DATABASE_URL", database_url.as_str())
            .output()
            .unwrap()
    };
    let output = run();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert_eq!(
        String::from_utf8(output.stderr).unwrap().trim(),
        "Error: \"Database role fukulow_app is missing; run `migrate roles` first\""
    );
    let history: Option<String> =
        sqlx::query_scalar("SELECT to_regclass('public._sqlx_migrations')::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(history.is_none());

    // Drive each production conversion, including SQLx's wrapped migration error.
    for (setup, operation) in [
        (
            "DROP VIEW public.pg_roles; CREATE FUNCTION public.fail_roles() RETURNS name LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'secret-role-query-payload'; END $$; CREATE VIEW public.pg_roles AS SELECT public.fail_roles() AS rolname",
            "migrate_role_lookup",
        ),
        (
            "DROP VIEW public.pg_roles; CREATE VIEW public.pg_roles AS SELECT 'fukulow_app'::name AS rolname; CREATE TABLE public.organizations (secret_migration_column text)",
            "migrate",
        ),
        ("DROP TABLE public.organizations", "migrate_grants"),
    ] {
        sqlx::raw_sql(setup).execute(&pool).await.unwrap();
        if operation == "migrate_grants" {
            fukulow_server::database::migrate(&pool).await.unwrap();
            // Fail grants even when another test has already created the role.
            sqlx::raw_sql("CREATE FUNCTION public.fail_grants() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'secret-grants-payload'; END $$; CREATE EVENT TRIGGER fail_grants ON ddl_command_start WHEN TAG IN ('REVOKE') EXECUTE FUNCTION public.fail_grants()")
                .execute(&pool).await.unwrap();
        }
        let output = run();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert_eq!(
            stderr.lines().count(),
            2,
            "one event and one fixed diagnostic"
        );
        let mut lines = stderr.lines();
        let event: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(
            event["fields"],
            serde_json::json!({"event":"database_failure", "kind":"database"}),
        );
        assert_eq!(
            event["span"],
            serde_json::json!({"name":"database", "operation":operation}),
        );
        assert_eq!(
            lines.next(),
            Some("Error: \"Database migration failed (diagnostics suppressed)\"")
        );
        assert_eq!(lines.next(), None, "exactly one database_failure event");
        for forbidden in [
            "secret-",
            "secret_",
            "postgres://",
            "fukulow_app",
            "ERROR:",
            "STATEMENT:",
        ] {
            assert!(!stderr.contains(forbidden), "{stderr}");
        }
    }
}

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
        assert!(error.contains("Database connection failed (diagnostics suppressed); check DATABASE_URL syntax, credentials and PostgreSQL availability"), "{error}");
    }
}

#[test]
fn roles_command_requires_password_before_connecting_and_rejects_unknown_commands() {
    for password in [
        None,
        Some(OsStr::new("")),
        Some(OsStr::from_bytes(INVALID_UTF8)),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_fukulow-server"));
        command.env_clear().args(["migrate", "roles"]);
        if let Some(password) = password {
            command.env("POSTGRES_APP_PASSWORD", password);
        }
        assert_config_error(
            command.output().unwrap(),
            "POSTGRES_APP_PASSWORD must be set to a nonempty app database password in UTF-8",
        );
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
                assert_eq!(
                    error,
                    "Error: \"FUKULOW_SETUP_TOKEN must be set to a private, random, nonblank UTF-8 token\"\n"
                );
            }
            assert!(!error.contains("setup-token-test-only"));
            assert!(!error.contains("setup-token-local-test-only"));
            assert!(!error.contains("custom-setup-token-test-only"));
            assert!(output.stdout.is_empty());
        }
    }
}

#[test]
fn startup_names_invalid_configuration_without_echoing_values() {
    for args in [
        vec![],
        vec!["migrate"],
        vec!["migrate", "roles"],
        vec!["rotate-history-generation", "--all"],
    ] {
        for invalid in [
            None,
            Some(OsStr::new("")),
            Some(OsStr::new(" \t")),
            Some(OsStr::from_bytes(INVALID_UTF8)),
        ] {
            let mut command = server_command();
            command
                .args(&args)
                .env("POSTGRES_APP_PASSWORD", "secret-role-test-only");
            if let Some(value) = invalid {
                command.env("DATABASE_URL", value);
            }
            assert_config_error(
                command.output().unwrap(),
                "DATABASE_URL must be set to a PostgreSQL connection URL in UTF-8",
            );
        }
    }

    for name in [
        "FUKULOW_ADDR",
        "FUKULOW_WS_ALLOWED_ORIGINS",
        "FUKULOW_TRUSTED_PROXIES",
        "FUKULOW_CLIENT_IP_HEADER",
        "FUKULOW_SEND_BURST",
        "FUKULOW_SEND_REFILL_PER_SECOND",
        "FUKULOW_DB_MAX_CONNECTIONS",
        "FUKULOW_DB_ACQUIRE_TIMEOUT_MS",
    ] {
        assert_config_error(
            server_command()
                .env("DATABASE_URL", "test-only-invalid-url")
                .env(name, OsStr::from_bytes(INVALID_UTF8))
                .output()
                .unwrap(),
            &format!("{name} must be valid UTF-8"),
        );
    }
    for (name, diagnostic) in [
        (
            "FUKULOW_SETUP_TOKEN",
            "FUKULOW_SETUP_TOKEN must be set to a private, random, nonblank UTF-8 token",
        ),
        (
            "FUKULOW_COOKIE_SECURE",
            "FUKULOW_COOKIE_SECURE must be true or false",
        ),
        (
            "FUKULOW_SEARCH_ENGINE",
            "FUKULOW_SEARCH_ENGINE must be disabled or d3r",
        ),
    ] {
        assert_config_error(
            server_command()
                .env("DATABASE_URL", "test-only-invalid-url")
                .env(name, OsStr::from_bytes(INVALID_UTF8))
                .output()
                .unwrap(),
            diagnostic,
        );
    }
    assert_config_error(
        server_command()
            .arg("probe")
            .env("FUKULOW_ADDR", "secret-config-test-only:invalid-port")
            .output()
            .unwrap(),
        "Readiness probe failed; check FUKULOW_ADDR (host:port) and that the app is ready",
    );
}

#[fukulow_test::test]
async fn startup_names_listener_setting_on_bind_failure(pool: sqlx::PgPool) {
    use sqlx::ConnectOptions;
    let test_support::TestPools { admin, app } = test_support::TestPools::new(pool).await;
    drop(admin);
    let database_url = app.connect_options().to_url_lossy();
    assert_config_error(
        server_command()
            .env("DATABASE_URL", database_url.as_str())
            .env("FUKULOW_ADDR", "secret-config-test-only:invalid-port")
            .output()
            .unwrap(),
        "Listener bind failed; set FUKULOW_ADDR to a local host and available port",
    );
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
fn startup_rejects_invalid_allowed_host_before_database_access() {
    for host in [
        "",
        "*",
        "https://chat.example",
        "chat.example/",
        "a.example,b.example",
        "user@chat.example",
        "chat.example:",
        "chat.example:65536",
        "[not-ip]:443",
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_fukulow-server"))
            .env_clear()
            .env("DATABASE_URL", "invalid-test-url")
            .env("FUKULOW_SETUP_TOKEN", "setup-token-test-only")
            .env("FUKULOW_ALLOWED_HOST", host)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8(output.stderr).unwrap();
        assert!(
            error.contains("FUKULOW_ALLOWED_HOST must be one hostname or IP"),
            "{error}"
        );
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
            vec![
                "",
                "0",
                "1",
                "2",
                "-1",
                "3.5",
                "101",
                "4294967295",
                "4294967296",
                "invalid",
            ],
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
