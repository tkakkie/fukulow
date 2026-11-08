# Invariants

Rules that must always hold. Each one lists the test that guards it. Add the test with the code.

| Rule | Test |
|---|---|
| A member of organization A cannot read or write data of organization B | `session_cannot_access_another_organization` (auth identity/session scope and composite FK; resource endpoints follow in later slices) |
| A user cannot read or post to a private channel they are not in | (todo) |
| A WebSocket connection never receives events for channels/organizations the user cannot access | (todo) |
| Posting the same client message id twice creates one message | (todo) |
| Setup creates exactly one organization and owner, even for concurrent requests | `setup_works_once_and_is_atomic`, `invalid_setup_does_not_consume_bootstrap` |
| Unauthenticated setup status reveals only whether an organization exists, never creates data, and is not cached, regardless of setup-token configuration | `setup_status_empty_database_is_public_and_reveals_only_boolean`, `setup_status_after_setup_is_public_and_reveals_only_boolean` |
| Only a valid, unexpired session resolves an identity; sign-out revokes cookie and bearer access | `sign_in_cookie_bearer_and_sign_out`, `invalid_expired_and_ambiguous_credentials_are_refused` |
| Failed sign-ins are limited per IP and per (organization, normalized email); unrelated accounts/IPs/organizations remain usable and limits expire | `failed_sign_ins_throttle_account_across_ips_but_not_other_accounts_or_organizations`, `failed_sign_ins_throttle_ip_and_ignore_spoofed_forwarded_header_by_default`, `trusted_proxy_uses_rightmost_client_ip_and_omitted_organization_shares_account_budget` |
| Throttled sign-ins return ErrorBody and Retry-After before password work; forwarded IPs require a configured trusted peer | `throttled_sign_in_skips_password_workers_and_database`, `forwarded_ip_requires_configured_header_and_trusted_peer`, `concurrent_reservations_are_bounded_and_cancellation_releases_them` |
