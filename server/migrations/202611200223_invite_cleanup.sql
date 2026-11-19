CREATE TABLE invite_tombstones (
    organization_id uuid NOT NULL REFERENCES organizations (organization_id),
    id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    owner_cursor uuid NOT NULL,
    admin_cursor uuid NOT NULL,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, owner_cursor),
    UNIQUE (organization_id, admin_cursor)
);

ALTER TABLE invite_tombstones ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON invite_tombstones FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());

-- Use direct column ranges so the app role can push each cutoff through RLS.
CREATE INDEX invites_cleanup_accepted ON invites (organization_id, accepted_at, id)
    WHERE accepted_at IS NOT NULL;
CREATE INDEX invites_cleanup_expired ON invites (organization_id, expires_at, id)
    WHERE accepted_at IS NULL;
CREATE INDEX invites_cleanup_revoked ON invites (organization_id, revoked_at, id)
    WHERE revoked_at IS NOT NULL;
