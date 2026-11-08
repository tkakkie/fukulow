# Invariants

Rules that must always hold. Each one lists the test that guards it. Add the test with the code.

| Rule | Test |
|---|---|
| A member of organization A cannot read or write data of organization B | `session_cannot_access_another_organization`, `channels_cannot_access_or_forge_another_organization`, `foreign_membership_does_not_grant_private_channel_visibility`, `channel_memberships_reject_cross_organization_references`, `messages_deny_cross_organization_send_and_list`, `equal_ids_in_two_organizations_do_not_collide`, `messages_reject_cross_organization_foreign_keys` |
| A user cannot read or post to a private channel they are not in | `private_channel_is_listed_only_for_its_creator`, `messages_deny_private_channel_nonmember_send_and_list`, `equal_ids_in_two_organizations_do_not_collide` |
| A WebSocket connection never receives events for channels/organizations the user cannot access | (todo) |
| Posting the same client message id twice creates one message | `concurrent_duplicate_sends_create_one_message_and_consume_one_sequence`, `committed_send_retry_returns_canonical_message_without_sequence_allocation`, `reused_client_id_conflicts_on_different_body_or_channel`, `concurrent_cross_channel_duplicate_conflicts_without_sequence_gap` |
| Setup creates exactly one organization and owner, even for concurrent requests | `setup_works_once_and_is_atomic`, `invalid_setup_does_not_consume_bootstrap` |
| Unauthenticated setup status reveals only whether an organization exists, never creates data, and is not cached, regardless of setup-token configuration | `setup_status_empty_database_is_public_and_reveals_only_boolean`, `setup_status_after_setup_is_public_and_reveals_only_boolean` |
| Only a valid, unexpired session resolves an identity; sign-out revokes cookie and bearer access | `sign_in_cookie_bearer_and_sign_out`, `invalid_expired_and_ambiguous_credentials_are_refused` |
| A private channel and its creator's membership are committed together | `private_channel_creation_rolls_back_if_membership_insert_fails`, `private_channel_is_listed_only_for_its_creator` |
| Per-channel sequences start at 1, are consecutive under concurrent sends, and consume no number on rollback | `concurrent_sends_allocate_unique_consecutive_channel_sequences`, `failed_send_after_sequence_allocation_leaves_no_gap` |
| Message pages are bounded, ascending and exclusive with has_more in the queried direction | `message_pages_are_bounded_exclusive_ascending_and_directional`, `message_query_validation_matches_contract` |
