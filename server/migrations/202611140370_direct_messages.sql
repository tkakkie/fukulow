-- Keep ordinary Channels and their grants/Unread lifetimes unchanged.
ALTER TABLE channels ADD COLUMN kind text NOT NULL DEFAULT 'channel';
ALTER TABLE channels ADD COLUMN lower_member_id uuid;
ALTER TABLE channels ADD COLUMN higher_member_id uuid;
ALTER TABLE channels ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE channels ALTER COLUMN name DROP NOT NULL;
ALTER TABLE channels ALTER COLUMN visibility DROP NOT NULL;
ALTER TABLE channels ADD CONSTRAINT channels_dm_shape CHECK (
    (kind='channel' AND name IS NOT NULL AND visibility IS NOT NULL
        AND lower_member_id IS NULL AND higher_member_id IS NULL)
    OR (kind='dm' AND name IS NULL AND visibility IS NULL
        AND lower_member_id IS NOT NULL AND higher_member_id IS NOT NULL
        AND lower_member_id < higher_member_id)
);
ALTER TABLE channels ADD FOREIGN KEY (organization_id,lower_member_id) REFERENCES users(organization_id,id);
ALTER TABLE channels ADD FOREIGN KEY (organization_id,higher_member_id) REFERENCES users(organization_id,id);
CREATE UNIQUE INDEX channels_dm_pair ON channels(organization_id,lower_member_id,higher_member_id) WHERE kind='dm';
DROP INDEX channels_organization_name_unique;
CREATE UNIQUE INDEX channels_organization_name_unique ON channels(organization_id,lower(name COLLATE "C")) WHERE kind='channel';

CREATE FUNCTION fixed_dm_pair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind <> OLD.kind OR (OLD.kind='dm' AND
        (NEW.organization_id,NEW.id,NEW.lower_member_id,NEW.higher_member_id,NEW.created_at)
        IS DISTINCT FROM (OLD.organization_id,OLD.id,OLD.lower_member_id,OLD.higher_member_id,OLD.created_at)) THEN
        RAISE EXCEPTION 'DM identity is immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER channels_fixed_dm BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION fixed_dm_pair();

-- Immutable grant-order projection avoids scanning unrelated or hidden pairs.
ALTER TABLE channel_members ADD COLUMN dm_created_at timestamptz;
CREATE INDEX channel_members_dm_order ON channel_members
    (organization_id,member_id,membership_revision,dm_created_at DESC,channel_id DESC)
    WHERE dm_created_at IS NOT NULL;
CREATE FUNCTION check_dm_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c channels;
BEGIN
    SELECT * INTO c FROM channels WHERE organization_id=NEW.organization_id AND id=NEW.channel_id;
    IF c.kind='dm' THEN
        IF NEW.member_id NOT IN (c.lower_member_id,c.higher_member_id) OR NEW.manager THEN
            RAISE EXCEPTION 'DM grants are participant-only without manager rights' USING ERRCODE='23514';
        END IF;
        NEW.dm_created_at := c.created_at;
    ELSE
        NEW.dm_created_at := NULL;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER channel_members_dm BEFORE INSERT OR UPDATE ON channel_members
    FOR EACH ROW EXECUTE FUNCTION check_dm_grant();

CREATE FUNCTION reject_dm_topic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM channels WHERE organization_id=NEW.organization_id AND id=NEW.channel_id AND kind='dm') THEN
        RAISE EXCEPTION 'DMs have no Topics' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER topics_no_dm BEFORE INSERT OR UPDATE ON topics FOR EACH ROW EXECUTE FUNCTION reject_dm_topic();

CREATE TABLE dm_discovery_counters (
    organization_id uuid NOT NULL,
    member_id uuid NOT NULL,
    membership_revision bigint NOT NULL,
    position bigint NOT NULL DEFAULT 0 CHECK(position>=0),
    PRIMARY KEY(organization_id,member_id,membership_revision),
    FOREIGN KEY(organization_id,member_id) REFERENCES users(organization_id,id)
);
CREATE TABLE dm_discovery (
    organization_id uuid NOT NULL,
    member_id uuid NOT NULL,
    membership_revision bigint NOT NULL,
    channel_id uuid NOT NULL,
    grant_id uuid NOT NULL,
    birth_position bigint NOT NULL CHECK(birth_position>0),
    latest_position bigint NOT NULL CHECK(latest_position>=birth_position),
    PRIMARY KEY(organization_id,member_id,membership_revision,channel_id),
    FOREIGN KEY(organization_id,member_id,membership_revision) REFERENCES dm_discovery_counters(organization_id,member_id,membership_revision),
    FOREIGN KEY(organization_id,channel_id,member_id) REFERENCES channel_members(organization_id,channel_id,member_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX dm_discovery_delta ON dm_discovery(organization_id,member_id,membership_revision,latest_position);
CREATE UNIQUE INDEX dm_discovery_birth ON dm_discovery(organization_id,member_id,membership_revision,birth_position);
ALTER TABLE dm_discovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE dm_discovery_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON dm_discovery FOR ALL USING(organization_id=fukulow_current_org()) WITH CHECK(organization_id=fukulow_current_org());
CREATE POLICY org_isolation ON dm_discovery_counters FOR ALL USING(organization_id=fukulow_current_org()) WITH CHECK(organization_id=fukulow_current_org());

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


CREATE FUNCTION fixed_dm_discovery_birth() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.organization_id,NEW.member_id,NEW.membership_revision,NEW.channel_id,NEW.birth_position)
        IS DISTINCT FROM (OLD.organization_id,OLD.member_id,OLD.membership_revision,OLD.channel_id,OLD.birth_position)
        OR NEW.latest_position <= OLD.latest_position THEN
        RAISE EXCEPTION 'Discovery birth is immutable and latest moves forward' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER dm_discovery_forward BEFORE UPDATE ON dm_discovery
    FOR EACH ROW EXECUTE FUNCTION fixed_dm_discovery_birth();
