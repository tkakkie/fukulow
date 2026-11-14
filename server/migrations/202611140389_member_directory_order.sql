-- Keep the full active Member directory in its response order. Cover the RLS
-- account predicate too; fresh pages may still need heap visibility checks.
CREATE INDEX users_directory_order ON users (organization_id, name, id)
    INCLUDE (role, membership_revision, account_id) WHERE deactivated_at IS NULL;
