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
