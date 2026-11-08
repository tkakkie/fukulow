# Invariants

Rules that must always hold. Each one lists the test that guards it. Add the test with the code.

| Rule | Test |
|---|---|
| A member of organization A cannot read or write data of organization B | `session_cannot_access_another_organization` (auth identity/session scope and composite FK; resource endpoints follow in later slices) |
| A user cannot read or post to a private channel they are not in | (todo) |
| A WebSocket connection never receives events for channels/organizations the user cannot access | (todo) |
| Posting the same client message id twice creates one message | (todo) |
| Setup creates exactly one organization and owner, even for concurrent requests | `setup_works_once_and_is_atomic`, `invalid_setup_does_not_consume_bootstrap` |
| Only a valid, unexpired session resolves an identity; sign-out revokes cookie and bearer access | `sign_in_cookie_bearer_and_sign_out`, `invalid_expired_and_ambiguous_credentials_are_refused` |
