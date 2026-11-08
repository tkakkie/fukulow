# Invariants

Rules that must always hold. Each one lists the test that guards it. Add the test with the code.

| Rule | Test |
|---|---|
| A member of organization A cannot read or write data of organization B | `session_cannot_access_another_organization`, `channels_cannot_access_or_forge_another_organization`, `foreign_membership_does_not_grant_private_channel_visibility`, `channel_memberships_reject_cross_organization_references` (auth and channel create/list; message endpoints follow in later slices) |
| A user cannot read or post to a private channel they are not in | `private_channel_is_listed_only_for_its_creator` (channel list visibility; message read/post follows in #17) |
| A WebSocket connection never receives events for channels/organizations the user cannot access | (todo) |
| Posting the same client message id twice creates one message | (todo) |
| Setup creates exactly one organization and owner, even for concurrent requests | `setup_works_once_and_is_atomic`, `invalid_setup_does_not_consume_bootstrap` |
| Unauthenticated setup status reveals only whether an organization exists, never creates data, and is not cached, regardless of setup-token configuration | `setup_status_empty_database_is_public_and_reveals_only_boolean`, `setup_status_after_setup_is_public_and_reveals_only_boolean` |
| Only a valid, unexpired session resolves an identity; sign-out revokes cookie and bearer access | `sign_in_cookie_bearer_and_sign_out`, `invalid_expired_and_ambiguous_credentials_are_refused` |
| A private channel and its creator's membership are committed together | `private_channel_creation_rolls_back_if_membership_insert_fails`, `private_channel_is_listed_only_for_its_creator` |
