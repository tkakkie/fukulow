-- Time cannot appear in an index predicate. Range over expiry at query time,
-- then sort the still-live candidates, rather than walking expired history in
-- creation order while holding the Organization lock. Keep all cursor anchors.
CREATE INDEX invites_outstanding_expiry ON invites (organization_id, expires_at)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
DROP INDEX invites_outstanding_order;
