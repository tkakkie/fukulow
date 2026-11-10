-- Positions belong to Messages. Grant triggers keep initialization independent of
-- the first fetch, including Members who never open a Channel during a grant.
CREATE TABLE channel_read_positions (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    member_id uuid NOT NULL,
    membership_revision bigint NOT NULL,
    initial_seq bigint NOT NULL CHECK (initial_seq >= 0),
    read_seq bigint NOT NULL CHECK (read_seq >= initial_seq),
    PRIMARY KEY (organization_id, channel_id, member_id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id),
    FOREIGN KEY (organization_id, member_id) REFERENCES users (organization_id, id)
);
CREATE INDEX channel_read_positions_member ON channel_read_positions (organization_id, member_id, channel_id);

CREATE TABLE topic_read_positions (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    member_id uuid NOT NULL,
    topic_id uuid NOT NULL,
    read_seq bigint NOT NULL CHECK (read_seq >= 0),
    PRIMARY KEY (organization_id, channel_id, member_id, topic_id),
    FOREIGN KEY (organization_id, channel_id, member_id)
        REFERENCES channel_read_positions (organization_id, channel_id, member_id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, channel_id, topic_id) REFERENCES topics (organization_id, channel_id, id)
);

-- Lock writes while capturing the migration baseline; committed counters and
-- Messages then agree, including Channels without any Messages (position zero).
LOCK TABLE users, channels, channel_members, channel_message_sequences, messages, topics IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO channel_read_positions
SELECT c.organization_id, c.id, u.id, u.membership_revision, COALESCE(s.seq, 0), COALESCE(s.seq, 0)
FROM channels c JOIN users u ON u.organization_id = c.organization_id AND u.deactivated_at IS NULL
LEFT JOIN channel_message_sequences s ON s.organization_id = c.organization_id AND s.channel_id = c.id
WHERE c.visibility = 'public' OR EXISTS (
    SELECT 1 FROM channel_members cm WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id
        AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision
);
INSERT INTO topic_read_positions
SELECT p.organization_id, p.channel_id, p.member_id, t.id, p.initial_seq
FROM channel_read_positions p JOIN topics t ON t.organization_id = p.organization_id AND t.channel_id = p.channel_id;

CREATE FUNCTION initialize_unread(o uuid, c uuid, m uuid, revision bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM channel_read_positions WHERE organization_id = o AND channel_id = c
        AND member_id = m AND membership_revision = revision) THEN RETURN; END IF;
    -- A send cannot commit between this baseline and the grant's COMMIT. Wait
    -- out an already unresolved COMMIT, then read its outcome in a fresh query.
    PERFORM pg_advisory_xact_lock_shared(hashtextextended(o::text || '/' || c::text, 135));
    INSERT INTO channel_read_positions
    SELECT o, c, m, revision, COALESCE(seq, 0), COALESCE(seq, 0)
    FROM (SELECT (SELECT seq FROM channel_message_sequences WHERE organization_id = o AND channel_id = c) AS seq) s
    ON CONFLICT DO NOTHING;
    -- Later Topics inherit initial_seq lazily; creating a Topic must never move
    -- the Channel position or initialize it to the Topic's first Message.
    INSERT INTO topic_read_positions
    SELECT o, c, m, t.id, p.initial_seq FROM topics t JOIN channel_read_positions p
        ON p.organization_id = o AND p.channel_id = c AND p.member_id = m
    WHERE t.organization_id = o AND t.channel_id = c ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION unread_member_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
    -- Serialize access changes so concurrent Member/Channel creation cannot
    -- both miss the other's row. Volatile trigger queries take fresh snapshots.
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 142));
    IF TG_OP = 'UPDATE' THEN
        IF OLD.deactivated_at IS NOT DISTINCT FROM NEW.deactivated_at THEN RETURN NEW; END IF;
        DELETE FROM channel_read_positions WHERE organization_id = NEW.organization_id AND member_id = NEW.id;
    END IF;
    IF NEW.deactivated_at IS NULL THEN
        FOR c IN SELECT id FROM channels WHERE organization_id = NEW.organization_id AND visibility = 'public' ORDER BY id LOOP
            PERFORM initialize_unread(NEW.organization_id, c.id, NEW.id, NEW.membership_revision);
        END LOOP;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER unread_member_access AFTER INSERT OR UPDATE OF deactivated_at ON users
FOR EACH ROW EXECUTE FUNCTION unread_member_access();

CREATE FUNCTION unread_channel_access() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record;
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
        FOR m IN SELECT id, membership_revision FROM users WHERE organization_id = NEW.organization_id AND deactivated_at IS NULL ORDER BY id LOOP
            PERFORM initialize_unread(NEW.organization_id, NEW.id, m.id, m.membership_revision);
        END LOOP;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER unread_channel_access AFTER INSERT OR UPDATE OF visibility ON channels
FOR EACH ROW EXECUTE FUNCTION unread_channel_access();

CREATE FUNCTION unread_private_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row channel_members; revision bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN grant_row := OLD; ELSE grant_row := NEW; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(grant_row.organization_id::text, 142));
    IF TG_OP = 'UPDATE' AND (OLD.organization_id, OLD.channel_id, OLD.member_id) IS DISTINCT FROM
        (NEW.organization_id, NEW.channel_id, NEW.member_id) THEN
        RAISE EXCEPTION 'Channel grant identity must not change; revoke and grant instead';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM channels WHERE organization_id = grant_row.organization_id AND id = grant_row.channel_id AND visibility = 'private') THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
    END IF;
    DELETE FROM channel_read_positions WHERE organization_id = grant_row.organization_id
        AND channel_id = grant_row.channel_id AND member_id = grant_row.member_id;
    IF TG_OP <> 'DELETE' THEN
        SELECT membership_revision INTO revision FROM users WHERE organization_id = grant_row.organization_id
            AND id = grant_row.member_id AND deactivated_at IS NULL;
        IF revision = grant_row.membership_revision THEN
            PERFORM initialize_unread(grant_row.organization_id, grant_row.channel_id, grant_row.member_id, revision);
        END IF;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER unread_private_grant AFTER INSERT OR UPDATE OR DELETE ON channel_members
FOR EACH ROW EXECUTE FUNCTION unread_private_grant();
