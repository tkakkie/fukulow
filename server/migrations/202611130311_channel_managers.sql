-- No backfill: old grants recorded no creator, so retain the unmanaged rule.
ALTER TABLE channel_members ADD COLUMN manager boolean NOT NULL DEFAULT false;

-- A right-only change must not enter #142/#135 or touch Unread. In particular,
-- Guest demotion clears rights across all Channels before Role reconciliation.
DROP TRIGGER unread_channel_grant ON channel_members;
CREATE TRIGGER unread_channel_grant
    AFTER INSERT OR DELETE OR UPDATE OF organization_id, channel_id, member_id, membership_revision
    ON channel_members FOR EACH ROW EXECUTE FUNCTION unread_channel_grant();

CREATE FUNCTION check_channel_manager() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Serialize with visibility writes even when a grant is changed by direct SQL.
    IF NEW.manager AND (
        NOT EXISTS (SELECT 1 FROM channels WHERE organization_id=NEW.organization_id
            AND id=NEW.channel_id AND visibility='private' FOR SHARE)
        OR EXISTS (SELECT 1 FROM users WHERE organization_id=NEW.organization_id
            AND id=NEW.member_id AND role='guest')
    ) THEN
        RAISE EXCEPTION 'Channel managers require a private Channel and non-Guest Member'
            USING ERRCODE='23514', CONSTRAINT='channel_members_manager';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER channel_members_manager BEFORE INSERT OR UPDATE ON channel_members
    FOR EACH ROW EXECUTE FUNCTION check_channel_manager();

CREATE FUNCTION check_public_channel_managers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.visibility='public' AND EXISTS (
        SELECT 1 FROM channel_members WHERE organization_id=NEW.organization_id
            AND channel_id=NEW.id AND manager
    ) THEN
        RAISE EXCEPTION 'Public Channels cannot carry manager rights'
            USING ERRCODE='23514', CONSTRAINT='channel_members_manager';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER channels_manager_visibility BEFORE UPDATE OF visibility ON channels
    FOR EACH ROW EXECUTE FUNCTION check_public_channel_managers();
