# Invariants: deployment

Server platform: database, startup, config, shutdown, schema guard, OpenAPI contract. Writing rules and the other parts: [index](../invariants.md).

| Rule | Test |
|---|---|
| Read-only Ok/Err reuses a clean backend; cancellation or BEGIN/ROLLBACK failure discards it; subsequent writes are read-write | `server/src/database/tests/read_only.rs::successful_read_only_reuses_clean_connection`, `server/src/database/tests/read_only.rs::read_only_body_error_reuses_clean_connection`, `server/src/database/tests/read_only.rs::cancelled_read_only_begin_discards_connection_before_next_write`, `server/src/database/tests/read_only.rs::cancelled_read_only_body_discards_connection_before_next_write`, `server/src/database/tests/read_only.rs::failed_rollback_keeps_body_error_and_discards_connection` |
| App startup reads history only; missing/extra/different versions, checksum mismatch or failed state prevents listening | `server/src/database/tests.rs::application_requires_migration_history_without_creating_it`, `server/src/database/tests.rs::application_rejects_migration_version_checksum_failed_missing_and_extra_rows` |
| Roles command fails before connecting without a nonempty password; unknown subcommands fail | `server/tests/config.rs::roles_command_requires_password_before_connecting_and_rejects_unknown_commands` |
| One-shot migrations bound advisory and DDL lock waits to 5 s; failure releases locks and allows a clean retry | `server/src/database/tests.rs::startup_migrations_timeout_on_advisory_lock_and_can_retry`, `server/src/database/tests.rs::startup_migrations_timeout_on_ddl_lock_and_can_retry_without_partial_changes` |
| The shutdown watch wakes 10,000 waiters concurrently; their simulated one-second waits overlap | `server/src/shutdown.rs::shutdown_watch_wakes_ten_thousand_waiters_concurrently` |
| Shutdown rejects every API operation and static request with 503 ErrorBody shutting_down, Retry-After 1-5 s and no-store; every API operation documents it | `server/tests/api_contract.rs::shutdown_rejects_every_api_operation_and_static_requests_with_retry_contract`, `server/tests/api_contract.rs::every_api_operation_documents_shutdown_retry_contract` |
| Generated REST/WebSocket OpenAPI matches the committed contract, including discriminator mappings, nullability, required fields, security and response headers | `server/tests/api_contract.rs::generated_openapi_matches_committed_contract` |
| Every generated and committed OpenAPI Response Object (incl. reusable, callback, webhook) has a string description non-empty after `str::trim()`; 162 in total | `server/tests/api_contract.rs::openapi_response_objects_require_descriptions`, `server/tests/api_contract.rs::response_description_check_rejects_removed_descriptions`, `server/tests/api_contract.rs::response_description_check_covers_reusable_and_nested_responses`, `server/tests/api_contract.rs::response_description_check_ignores_path_item_metadata`, `server/tests/api_contract.rs::response_description_count_rejects_changed_contract` |
| App responses, including errors/fallbacks, carry strict CSP, nosniff and Referrer-Policy; CSP Host reflection cannot inject directives | `server/src/lib.rs::security_headers_cover_success_errors_and_fallbacks`, `server/src/lib.rs::csp_websocket_source_rejects_injected_or_ambiguous_hosts` |
| Only Vite manifest assets get immutable caching; HTML/fallback/unhashed files revalidate; API remains no-store | `server/src/lib.rs::html_and_unhashed_files_revalidate_and_hashed_assets_are_immutable`, `server/src/lib.rs::security_headers_cover_success_errors_and_fallbacks` |
| Membership routes/Capabilities are generated; list records omit email/credentials and loss-event data is channel_id only | `server/tests/api_contract.rs::channel_membership_paths_capabilities_and_channel_only_loss_contract_are_generated` |

## Rows in other parts

Rows that also govern this area, listed by a test name from the row in that part.

- [auth](auth.md): `startup_requires_setup_token_regardless_of_cookie_security`, `startup_rejects_partial_or_invalid_proxy_configuration_before_database_access`
- [realtime](realtime.md): `disconnected_http_send_stays_in_drain_until_persistence_and_notification_finish`
