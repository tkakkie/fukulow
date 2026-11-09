CREATE INDEX sessions_organization_expiry ON sessions (organization_id, expires_at, token_hash);
