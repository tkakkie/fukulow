-- Messages owns positions. Keep #142's Organization serialization and #135's
-- committed-sequence barrier while extending visibility to Roles/public grants.
LOCK TABLE users, channels, channel_members, channel_message_sequences, messages, topics,
    channel_read_positions, topic_read_positions IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION unread_member_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE visible_channel record;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 142));
    IF TG_OP = 'UPDATE' THEN
        IF (OLD.role, OLD.deactivated_at, OLD.membership_revision) IS NOT DISTINCT FROM
           (NEW.role, NEW.deactivated_at, NEW.membership_revision) THEN RETURN NEW; END IF;
    END IF;
    -- Preserve every continuous access epoch, including its Topic positions.
    DELETE FROM channel_read_positions p
    WHERE p.organization_id = NEW.organization_id AND p.member_id = NEW.id AND (
        NEW.deactivated_at IS NOT NULL OR p.membership_revision <> NEW.membership_revision OR NOT EXISTS (
            SELECT 1 FROM channels c WHERE c.organization_id = p.organization_id AND c.id = p.channel_id AND (
                (c.visibility = 'public' AND NEW.role <> 'guest') OR EXISTS (
                    SELECT 1 FROM channel_members cm WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id
                        AND cm.member_id = NEW.id AND cm.membership_revision = NEW.membership_revision))));
    IF NEW.deactivated_at IS NULL THEN
        FOR visible_channel IN SELECT id FROM channels WHERE organization_id = NEW.organization_id AND (
            (visibility = 'public' AND NEW.role <> 'guest') OR EXISTS (
                SELECT 1 FROM channel_members cm WHERE cm.organization_id = NEW.organization_id AND cm.channel_id = channels.id
                    AND cm.member_id = NEW.id AND cm.membership_revision = NEW.membership_revision
            )) ORDER BY id LOOP
            PERFORM initialize_unread(NEW.organization_id, visible_channel.id, NEW.id, NEW.membership_revision);
        END LOOP;
    END IF;
    RETURN NEW;
END $$;
DROP TRIGGER unread_member_access ON users;
CREATE TRIGGER unread_member_access AFTER INSERT OR UPDATE OF role, deactivated_at ON users
FOR EACH ROW EXECUTE FUNCTION unread_member_access();

CREATE OR REPLACE FUNCTION unread_channel_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 142));
    IF TG_OP = 'UPDATE' THEN
        IF OLD.visibility = NEW.visibility THEN RETURN NEW; END IF;
        DELETE FROM channel_read_positions p WHERE p.organization_id = NEW.organization_id AND p.channel_id = NEW.id
            AND NEW.visibility = 'private' AND NOT EXISTS (
                SELECT 1 FROM channel_members cm WHERE cm.organization_id = p.organization_id AND cm.channel_id = p.channel_id
                    AND cm.member_id = p.member_id AND cm.membership_revision = p.membership_revision);
    END IF;
    IF NEW.visibility = 'public' THEN
        PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.organization_id::text || '/' || NEW.id::text, 135));
        INSERT INTO channel_read_positions
        SELECT NEW.organization_id, NEW.id, u.id, u.membership_revision, COALESCE(s.seq, 0), COALESCE(s.seq, 0)
        FROM users u LEFT JOIN channel_message_sequences s ON s.organization_id = NEW.organization_id AND s.channel_id = NEW.id
        WHERE u.organization_id = NEW.organization_id AND u.deactivated_at IS NULL AND (
            u.role <> 'guest' OR EXISTS (
                SELECT 1 FROM channel_members cm WHERE cm.organization_id = NEW.organization_id AND cm.channel_id = NEW.id
                    AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision))
        ON CONFLICT DO NOTHING;
        INSERT INTO topic_read_positions
        SELECT p.organization_id, p.channel_id, p.member_id, t.id, p.initial_seq
        FROM channel_read_positions p JOIN topics t ON t.organization_id = p.organization_id AND t.channel_id = p.channel_id
        WHERE p.organization_id = NEW.organization_id AND p.channel_id = NEW.id ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER unread_private_grant ON channel_members;
DROP FUNCTION unread_private_grant();
CREATE FUNCTION unread_channel_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row channel_members; revision bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN grant_row := OLD; ELSE grant_row := NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(grant_row.organization_id::text, 142));
    IF TG_OP = 'UPDATE' AND (OLD.organization_id, OLD.channel_id, OLD.member_id) IS DISTINCT FROM
        (NEW.organization_id, NEW.channel_id, NEW.member_id) THEN
        RAISE EXCEPTION 'Channel grant identity must not change; revoke and grant instead';
    END IF;
    -- Read current access after the serialization lock, rather than assuming
    -- every grant mutation starts a new epoch (public grants may be redundant).
    SELECT u.membership_revision INTO revision FROM users u JOIN channels c
        ON c.organization_id = u.organization_id AND c.id = grant_row.channel_id
    WHERE u.organization_id = grant_row.organization_id AND u.id = grant_row.member_id AND u.deactivated_at IS NULL AND (
        (c.visibility = 'public' AND u.role <> 'guest') OR EXISTS (
            SELECT 1 FROM channel_members cm WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id
                AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision));
    DELETE FROM channel_read_positions WHERE organization_id = grant_row.organization_id
        AND channel_id = grant_row.channel_id AND member_id = grant_row.member_id
        AND (revision IS NULL OR membership_revision <> revision);
    IF revision IS NOT NULL THEN
        PERFORM initialize_unread(grant_row.organization_id, grant_row.channel_id, grant_row.member_id, revision);
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER unread_channel_grant AFTER INSERT OR UPDATE OR DELETE ON channel_members
FOR EACH ROW EXECUTE FUNCTION unread_channel_grant();

-- Repair pre-#144 rows while writes are excluded. Cascade removes inaccessible
-- Topic positions; visible rows and read_seq survive, missing rows start now.
DELETE FROM channel_read_positions p WHERE NOT EXISTS (
    SELECT 1 FROM users u JOIN channels c ON c.organization_id = u.organization_id
    WHERE u.organization_id = p.organization_id AND u.id = p.member_id AND c.id = p.channel_id
        AND u.deactivated_at IS NULL AND u.membership_revision = p.membership_revision AND (
            (c.visibility = 'public' AND u.role <> 'guest') OR EXISTS (
                SELECT 1 FROM channel_members cm WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id
                    AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision)));
INSERT INTO channel_read_positions
SELECT c.organization_id, c.id, u.id, u.membership_revision, COALESCE(s.seq, 0), COALESCE(s.seq, 0)
FROM channels c JOIN users u ON u.organization_id = c.organization_id AND u.deactivated_at IS NULL
LEFT JOIN channel_message_sequences s ON s.organization_id = c.organization_id AND s.channel_id = c.id
WHERE (c.visibility = 'public' AND u.role <> 'guest') OR EXISTS (
    SELECT 1 FROM channel_members cm WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id
        AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision)
ON CONFLICT DO NOTHING;
INSERT INTO topic_read_positions
SELECT p.organization_id, p.channel_id, p.member_id, t.id, p.initial_seq
FROM channel_read_positions p JOIN topics t ON t.organization_id = p.organization_id AND t.channel_id = p.channel_id
ON CONFLICT DO NOTHING;
