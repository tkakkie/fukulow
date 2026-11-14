ALTER TABLE invites ADD COLUMN revoked_at timestamptz;
ALTER TABLE invites ADD COLUMN created_at timestamptz;
-- Existing Invites were issued with exactly seven days of validity.
UPDATE invites SET created_at = expires_at - interval '7 days';
ALTER TABLE invites ALTER COLUMN created_at SET NOT NULL;
ALTER TABLE invites ALTER COLUMN created_at SET DEFAULT now();
-- Separate opaque anchors bind continuations to the current management Role.
-- Retaining them on consumed/revoked rows keeps keyset boundaries usable.
ALTER TABLE invites ADD COLUMN owner_cursor uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE invites ADD COLUMN admin_cursor uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX invites_owner_cursor ON invites (organization_id, owner_cursor);
CREATE UNIQUE INDEX invites_admin_cursor ON invites (organization_id, admin_cursor);
CREATE INDEX invites_outstanding_order ON invites (organization_id, created_at, id)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
