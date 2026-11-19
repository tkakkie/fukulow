ALTER TABLE channels
    ADD COLUMN archived_at timestamptz,
    ADD CONSTRAINT channels_dm_never_archived CHECK (kind <> 'dm' OR archived_at IS NULL);
