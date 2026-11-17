-- #225: a Channel becoming public initializes Topic positions only for the Members
-- whose Channel position this statement inserts. Re-joining every existing position
-- with every Topic was redundant (ON CONFLICT DO NOTHING): readers treat a missing
-- Topic position as initial_seq, the value that join would have inserted.
CREATE OR REPLACE FUNCTION unread_channel_access() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind='dm' THEN RETURN NEW; END IF;
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
        WITH inserted AS (
            INSERT INTO channel_read_positions
            SELECT NEW.organization_id, NEW.id, u.id, u.membership_revision, COALESCE(s.seq, 0), COALESCE(s.seq, 0)
            FROM users u LEFT JOIN channel_message_sequences s ON s.organization_id = NEW.organization_id AND s.channel_id = NEW.id
            WHERE u.organization_id = NEW.organization_id AND u.deactivated_at IS NULL AND (
                u.role <> 'guest' OR EXISTS (
                    SELECT 1 FROM channel_members cm WHERE cm.organization_id = NEW.organization_id AND cm.channel_id = NEW.id
                        AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision))
            ON CONFLICT DO NOTHING
            RETURNING organization_id, channel_id, member_id, initial_seq
        )
        INSERT INTO topic_read_positions
        SELECT i.organization_id, i.channel_id, i.member_id, t.id, i.initial_seq
        FROM inserted i JOIN topics t ON t.organization_id = i.organization_id AND t.channel_id = i.channel_id
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
END $$;
