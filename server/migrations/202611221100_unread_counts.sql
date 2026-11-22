-- #519 A3: Channel-list Unread and Mention counts without reading messages.
-- For a scope (the main timeline, scope_id nil, or one Topic) and a range (a,b]:
--   live(a,b] = appended(a,b] + sum(corrections in (a,b])
-- appended counts Messages created in the scope, every sender, from creation; it never
-- changes for b <= the committed counter, because new Messages get higher seqs.
-- A correction is [live in the scope now] - [created in the scope], per (scope, Message).
-- Positions store the appended ordinals at read_seq, so Unread in (r, S] is
--   (A - read_ordinal) - (A_own - read_own_ordinal) + other senders' corrections in (r, S].
-- Triggers keep every write path exact (send, Move, Delete, fixtures, an older image).
-- They run as the invoker under RLS with the writer's Organization context.
LOCK TABLE users, channels, channel_members, channel_message_sequences, messages, topics,
    channel_read_positions, topic_read_positions, message_mentions IN SHARE ROW EXCLUSIVE MODE;

-- member_id nil is the scope total; otherwise the sender. No FK to users for that reason.
CREATE TABLE message_append_counts (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    scope_id uuid NOT NULL,
    member_id uuid NOT NULL,
    appended bigint NOT NULL CHECK (appended >= 0),
    PRIMARY KEY (organization_id, channel_id, scope_id, member_id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id)
) WITH (fillfactor = 70);

-- No FK to messages: a hard-deleted Message keeps its correction so the identity holds.
CREATE TABLE message_count_corrections (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    scope_id uuid NOT NULL,
    seq bigint NOT NULL,
    message_id uuid NOT NULL,
    sender uuid NOT NULL,
    delta smallint NOT NULL CHECK (delta IN (-1, 1)),
    PRIMARY KEY (organization_id, channel_id, scope_id, seq, message_id) INCLUDE (sender, delta),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id)
);

ALTER TABLE message_append_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_count_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON message_append_counts FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON message_count_corrections FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());

ALTER TABLE channel_read_positions ADD COLUMN read_ordinal bigint, ADD COLUMN read_own_ordinal bigint;
ALTER TABLE topic_read_positions ADD COLUMN read_ordinal bigint, ADD COLUMN read_own_ordinal bigint;
-- Kept for the sender and for deleted Messages: the Mention list shows them all.
ALTER TABLE message_mentions ADD COLUMN seq bigint, ADD COLUMN topic_id uuid, ADD COLUMN counted boolean;

-- Backfill: each existing Message's current scope is its creation scope (appended = live,
-- no corrections). channel_log keeps only Move roots, so true creation scopes cannot be
-- rebuilt; the identity holds at the cutover and every later change goes through triggers.
INSERT INTO message_append_counts
SELECT organization_id, channel_id, COALESCE(topic_id, '00000000-0000-0000-0000-000000000000'), v.member_id, count(*)
FROM messages m CROSS JOIN LATERAL (VALUES ('00000000-0000-0000-0000-000000000000'::uuid), (m.sender)) v(member_id)
WHERE NOT m.deleted
GROUP BY 1, 2, 3, 4;

UPDATE message_mentions mm SET seq = m.seq, topic_id = m.topic_id, counted = m.sender <> mm.member_id AND NOT m.deleted
FROM messages m WHERE m.organization_id = mm.organization_id AND m.id = mm.message_id;

-- A missing Topic position means ordinals 0 at initial_seq. That is exact only if the
-- Topic appended nothing up to initial_seq; with appended = live, add the rows for
-- Topics holding live Messages there. Readers already treat a missing row as initial_seq.
INSERT INTO topic_read_positions (organization_id, channel_id, member_id, topic_id, read_seq)
SELECT p.organization_id, p.channel_id, p.member_id, t.id, p.initial_seq
FROM channel_read_positions p JOIN topics t ON t.organization_id = p.organization_id AND t.channel_id = p.channel_id
WHERE EXISTS (SELECT 1 FROM messages m WHERE m.organization_id = t.organization_id AND m.channel_id = t.channel_id
    AND m.topic_id = t.id AND NOT m.deleted AND m.seq <= p.initial_seq)
ON CONFLICT DO NOTHING;

UPDATE channel_read_positions p SET (read_ordinal, read_own_ordinal) = (
    SELECT count(*), count(*) FILTER (WHERE m.sender = p.member_id) FROM messages m
    WHERE m.organization_id = p.organization_id AND m.channel_id = p.channel_id AND m.topic_id IS NULL
        AND NOT m.deleted AND m.seq <= p.read_seq);
UPDATE topic_read_positions p SET (read_ordinal, read_own_ordinal) = (
    SELECT count(*), count(*) FILTER (WHERE m.sender = p.member_id) FROM messages m
    WHERE m.organization_id = p.organization_id AND m.channel_id = p.channel_id AND m.topic_id = p.topic_id
        AND NOT m.deleted AND m.seq <= p.read_seq);

ALTER TABLE channel_read_positions ALTER COLUMN read_ordinal SET NOT NULL, ALTER COLUMN read_own_ordinal SET NOT NULL,
    ADD CONSTRAINT channel_read_positions_ordinals CHECK (read_own_ordinal BETWEEN 0 AND read_ordinal);
ALTER TABLE topic_read_positions ALTER COLUMN read_ordinal SET NOT NULL, ALTER COLUMN read_own_ordinal SET NOT NULL,
    ADD CONSTRAINT topic_read_positions_ordinals CHECK (read_own_ordinal BETWEEN 0 AND read_ordinal);
ALTER TABLE message_mentions ALTER COLUMN seq SET NOT NULL, ALTER COLUMN counted SET NOT NULL;
CREATE INDEX message_mentions_counted ON message_mentions (organization_id, member_id, channel_id, topic_id, seq) WHERE counted;

-- Appended ordinals at x for (scope, member), in one statement so totals and the tail
-- share one snapshot: ordinal(x) = A - live(x,inf) + corrections(x,inf). Exact for every
-- x at or below the committed counter, whatever commits concurrently.
CREATE FUNCTION message_count_ordinals(o uuid, c uuid, scope uuid, m uuid, x bigint,
    OUT ordinal bigint, OUT own_ordinal bigint) LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF scope = '00000000-0000-0000-0000-000000000000' THEN
        SELECT a.total - l.total + r.total, a.own - l.own + r.own INTO ordinal, own_ordinal
        FROM (SELECT COALESCE(sum(appended) FILTER (WHERE member_id = scope), 0) AS total,
                COALESCE(sum(appended) FILTER (WHERE member_id = m), 0) AS own
            FROM message_append_counts WHERE organization_id = o AND channel_id = c AND scope_id = scope AND member_id IN (scope, m)) a,
            (SELECT count(*) AS total, count(*) FILTER (WHERE sender = m) AS own FROM messages
            WHERE organization_id = o AND channel_id = c AND topic_id IS NULL AND NOT deleted AND seq > x) l,
            (SELECT COALESCE(sum(delta), 0) AS total, COALESCE(sum(delta) FILTER (WHERE sender = m), 0) AS own
            FROM message_count_corrections WHERE organization_id = o AND channel_id = c AND scope_id = scope AND seq > x) r;
    ELSE
        SELECT a.total - l.total + r.total, a.own - l.own + r.own INTO ordinal, own_ordinal
        FROM (SELECT COALESCE(sum(appended) FILTER (WHERE member_id = '00000000-0000-0000-0000-000000000000'), 0) AS total,
                COALESCE(sum(appended) FILTER (WHERE member_id = m), 0) AS own
            FROM message_append_counts WHERE organization_id = o AND channel_id = c AND scope_id = scope
                AND member_id IN ('00000000-0000-0000-0000-000000000000', m)) a,
            (SELECT count(*) AS total, count(*) FILTER (WHERE sender = m) AS own FROM messages
            WHERE organization_id = o AND channel_id = c AND topic_id = scope AND NOT deleted AND seq > x) l,
            (SELECT COALESCE(sum(delta), 0) AS total, COALESCE(sum(delta) FILTER (WHERE sender = m), 0) AS own
            FROM message_count_corrections WHERE organization_id = o AND channel_id = c AND scope_id = scope AND seq > x) r;
    END IF;
END $$;

-- appended(a,b] for b at or below the committed counter: stable, so it needs no shared snapshot.
CREATE FUNCTION message_count_range(o uuid, c uuid, scope uuid, m uuid, a bigint, b bigint,
    OUT appended bigint, OUT own_appended bigint) LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF scope = '00000000-0000-0000-0000-000000000000' THEN
        SELECT l.total - r.total, l.own - r.own INTO appended, own_appended
        FROM (SELECT count(*) AS total, count(*) FILTER (WHERE sender = m) AS own FROM messages
            WHERE organization_id = o AND channel_id = c AND topic_id IS NULL AND NOT deleted AND seq > a AND seq <= b) l,
            (SELECT COALESCE(sum(delta), 0) AS total, COALESCE(sum(delta) FILTER (WHERE sender = m), 0) AS own
            FROM message_count_corrections WHERE organization_id = o AND channel_id = c AND scope_id = scope AND seq > a AND seq <= b) r;
    ELSE
        SELECT l.total - r.total, l.own - r.own INTO appended, own_appended
        FROM (SELECT count(*) AS total, count(*) FILTER (WHERE sender = m) AS own FROM messages
            WHERE organization_id = o AND channel_id = c AND topic_id = scope AND NOT deleted AND seq > a AND seq <= b) l,
            (SELECT COALESCE(sum(delta), 0) AS total, COALESCE(sum(delta) FILTER (WHERE sender = m), 0) AS own
            FROM message_count_corrections WHERE organization_id = o AND channel_id = c AND scope_id = scope AND seq > a AND seq <= b) r;
    END IF;
END $$;

-- Ordinals are always computed here, never taken from the writer. An unchanged read_seq
-- keeps them; an advance takes the shorter side: the newly read range or the remaining tail.
CREATE FUNCTION unread_position_ordinals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    scope uuid := '00000000-0000-0000-0000-000000000000';
    top bigint;
    added bigint;
    own_added bigint;
    same boolean := false;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        same := (OLD.organization_id, OLD.channel_id, OLD.member_id) = (NEW.organization_id, NEW.channel_id, NEW.member_id);
    END IF;
    IF TG_TABLE_NAME = 'topic_read_positions' THEN
        scope := NEW.topic_id;
        IF same THEN same := OLD.topic_id = NEW.topic_id; END IF;
    END IF;
    IF same THEN
        IF NEW.read_seq = OLD.read_seq THEN
            NEW.read_ordinal := OLD.read_ordinal;
            NEW.read_own_ordinal := OLD.read_own_ordinal;
            RETURN NEW;
        END IF;
        IF NEW.read_seq > OLD.read_seq THEN
            IF scope = '00000000-0000-0000-0000-000000000000' THEN
                SELECT seq INTO top FROM channel_message_sequences WHERE organization_id = NEW.organization_id AND channel_id = NEW.channel_id;
            ELSE
                SELECT last_seq INTO top FROM topics WHERE organization_id = NEW.organization_id AND id = scope;
            END IF;
            IF NEW.read_seq - OLD.read_seq <= COALESCE(top, 0) - NEW.read_seq THEN
                SELECT r.appended, r.own_appended INTO added, own_added
                FROM message_count_range(NEW.organization_id, NEW.channel_id, scope, NEW.member_id, OLD.read_seq, NEW.read_seq) r;
                NEW.read_ordinal := OLD.read_ordinal + added;
                NEW.read_own_ordinal := OLD.read_own_ordinal + own_added;
                RETURN NEW;
            END IF;
        END IF;
    END IF;
    SELECT o.ordinal, o.own_ordinal INTO NEW.read_ordinal, NEW.read_own_ordinal
    FROM message_count_ordinals(NEW.organization_id, NEW.channel_id, scope, NEW.member_id, NEW.read_seq) o;
    RETURN NEW;
END $$;
CREATE TRIGGER channel_read_positions_ordinals BEFORE INSERT OR UPDATE ON channel_read_positions
FOR EACH ROW EXECUTE FUNCTION unread_position_ordinals();
CREATE TRIGGER topic_read_positions_ordinals BEFORE INSERT OR UPDATE ON topic_read_positions
FOR EACH ROW EXECUTE FUNCTION unread_position_ordinals();

-- mentions.rs inserts after the Message in the same transaction.
CREATE FUNCTION message_mention_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    SELECT m.seq, m.topic_id, m.sender <> NEW.member_id AND NOT m.deleted INTO NEW.seq, NEW.topic_id, NEW.counted
    FROM messages m WHERE m.organization_id = NEW.organization_id AND m.id = NEW.message_id;
    IF NOT FOUND THEN
        -- Leave the refusal to the Message foreign key, not the NOT NULL columns.
        NEW.seq := 0;
        NEW.counted := false;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER message_mentions_scope BEFORE INSERT ON message_mentions
FOR EACH ROW EXECUTE FUNCTION message_mention_scope();

-- A duplicate send (ON CONFLICT DO NOTHING) inserts no row and changes nothing.
CREATE FUNCTION message_counts_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO message_append_counts AS k (organization_id, channel_id, scope_id, member_id, appended)
    SELECT n.organization_id, n.channel_id, COALESCE(n.topic_id, '00000000-0000-0000-0000-000000000000'), v.member_id, count(*)
    FROM inserted_messages n CROSS JOIN LATERAL (VALUES ('00000000-0000-0000-0000-000000000000'::uuid), (n.sender)) v(member_id)
    GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
    ON CONFLICT (organization_id, channel_id, scope_id, member_id) DO UPDATE SET appended = k.appended + EXCLUDED.appended;
    INSERT INTO message_count_corrections
    SELECT organization_id, channel_id, COALESCE(topic_id, '00000000-0000-0000-0000-000000000000'), seq, id, sender, -1
    FROM inserted_messages WHERE deleted;
    RETURN NULL;
END $$;
CREATE TRIGGER messages_counts_inserted AFTER INSERT ON messages
REFERENCING NEW TABLE AS inserted_messages FOR EACH STATEMENT EXECUTE FUNCTION message_counts_inserted();

-- Move, Delete and undelete: -[live before] in the old scope, +[live after] in the new one,
-- netted per (scope, Message). An edit nets to nothing. Mention rows follow the Message.
CREATE FUNCTION message_counts_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    WITH d AS (
        SELECT organization_id, channel_id, scope_id, seq, message_id, max(sender::text)::uuid AS sender, sum(delta) AS delta
        FROM (
            SELECT organization_id, channel_id, COALESCE(topic_id, '00000000-0000-0000-0000-000000000000') AS scope_id, seq,
                id AS message_id, sender, -1 AS delta FROM old_messages WHERE NOT deleted
            UNION ALL
            SELECT organization_id, channel_id, COALESCE(topic_id, '00000000-0000-0000-0000-000000000000'), seq, id, sender, 1
            FROM new_messages WHERE NOT deleted
        ) x GROUP BY 1, 2, 3, 4, 5 HAVING sum(delta) <> 0
    ), cancelled AS (
        DELETE FROM message_count_corrections c USING d
        WHERE c.organization_id = d.organization_id AND c.channel_id = d.channel_id AND c.scope_id = d.scope_id
            AND c.seq = d.seq AND c.message_id = d.message_id AND c.delta + d.delta = 0
        RETURNING c.organization_id, c.channel_id, c.scope_id, c.seq, c.message_id
    )
    INSERT INTO message_count_corrections AS c
    SELECT d.organization_id, d.channel_id, d.scope_id, d.seq, d.message_id, d.sender, d.delta FROM d
    WHERE NOT EXISTS (SELECT 1 FROM cancelled x WHERE (x.organization_id, x.channel_id, x.scope_id, x.seq, x.message_id)
        = (d.organization_id, d.channel_id, d.scope_id, d.seq, d.message_id))
    ORDER BY 1, 2, 3, 4, 5
    ON CONFLICT (organization_id, channel_id, scope_id, seq, message_id) DO UPDATE SET delta = c.delta + EXCLUDED.delta;
    UPDATE message_mentions mm SET seq = n.seq, topic_id = n.topic_id, counted = n.sender <> mm.member_id AND NOT n.deleted
    FROM new_messages n
    WHERE mm.organization_id = n.organization_id AND mm.message_id = n.id
        AND (mm.seq, mm.topic_id, mm.counted) IS DISTINCT FROM (n.seq, n.topic_id, n.sender <> mm.member_id AND NOT n.deleted);
    RETURN NULL;
END $$;
CREATE TRIGGER messages_counts_updated AFTER UPDATE ON messages
REFERENCING OLD TABLE AS old_messages NEW TABLE AS new_messages FOR EACH STATEMENT EXECUTE FUNCTION message_counts_updated();

-- Nothing hard-deletes Messages today; this only keeps the identity if something does.
CREATE FUNCTION message_counts_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    WITH d AS (
        SELECT organization_id, channel_id, COALESCE(topic_id, '00000000-0000-0000-0000-000000000000') AS scope_id, seq,
            id AS message_id, sender, -1 AS delta
        FROM old_messages o WHERE NOT deleted
            AND EXISTS (SELECT 1 FROM channels ch WHERE ch.organization_id = o.organization_id AND ch.id = o.channel_id)
    ), cancelled AS (
        DELETE FROM message_count_corrections c USING d
        WHERE c.organization_id = d.organization_id AND c.channel_id = d.channel_id AND c.scope_id = d.scope_id
            AND c.seq = d.seq AND c.message_id = d.message_id AND c.delta = 1
        RETURNING c.organization_id, c.channel_id, c.scope_id, c.seq, c.message_id
    )
    INSERT INTO message_count_corrections AS c
    SELECT d.organization_id, d.channel_id, d.scope_id, d.seq, d.message_id, d.sender, d.delta FROM d
    WHERE NOT EXISTS (SELECT 1 FROM cancelled x WHERE (x.organization_id, x.channel_id, x.scope_id, x.seq, x.message_id)
        = (d.organization_id, d.channel_id, d.scope_id, d.seq, d.message_id))
    ORDER BY 1, 2, 3, 4, 5;
    RETURN NULL;
END $$;
CREATE TRIGGER messages_counts_deleted AFTER DELETE ON messages
REFERENCING OLD TABLE AS old_messages FOR EACH STATEMENT EXECUTE FUNCTION message_counts_deleted();

-- Read-only identity check for one Organization; empty when every stored count is exact.
-- Tests call it after every scenario; the migration requires it empty before COMMIT.
CREATE FUNCTION message_counts_check(o uuid)
RETURNS TABLE (kind text, channel_id uuid, scope_id uuid, member_id uuid, expected bigint, actual bigint)
LANGUAGE sql STABLE AS $$
WITH nil AS (SELECT '00000000-0000-0000-0000-000000000000'::uuid AS id),
live AS (
    SELECT m.channel_id, COALESCE(m.topic_id, nil.id) AS scope_id, v.member_id, count(*) AS n
    FROM messages m, nil, LATERAL (VALUES (nil.id), (m.sender)) v(member_id)
    WHERE m.organization_id = o AND NOT m.deleted GROUP BY 1, 2, 3
), corr AS (
    SELECT c.channel_id, c.scope_id, v.member_id, sum(c.delta) AS n
    FROM message_count_corrections c, nil, LATERAL (VALUES (nil.id), (c.sender)) v(member_id)
    WHERE c.organization_id = o GROUP BY 1, 2, 3
), expected_appended AS (
    SELECT COALESCE(l.channel_id, c.channel_id) AS channel_id, COALESCE(l.scope_id, c.scope_id) AS scope_id,
        COALESCE(l.member_id, c.member_id) AS member_id, COALESCE(l.n, 0) - COALESCE(c.n, 0) AS n
    FROM live l FULL JOIN corr c USING (channel_id, scope_id, member_id)
), positions AS (
    SELECT p.channel_id, nil.id AS scope_id, p.member_id, p.read_seq, p.read_ordinal, p.read_own_ordinal
    FROM channel_read_positions p, nil WHERE p.organization_id = o
    UNION ALL
    SELECT p.channel_id, p.topic_id, p.member_id, p.read_seq, p.read_ordinal, p.read_own_ordinal
    FROM topic_read_positions p WHERE p.organization_id = o
    UNION ALL
    -- A missing Topic position is ordinals 0 at initial_seq.
    SELECT p.channel_id, t.id, p.member_id, p.initial_seq, 0, 0
    FROM channel_read_positions p JOIN topics t ON t.organization_id = p.organization_id AND t.channel_id = p.channel_id
    WHERE p.organization_id = o AND NOT EXISTS (SELECT 1 FROM topic_read_positions tr WHERE tr.organization_id = o
        AND tr.channel_id = p.channel_id AND tr.member_id = p.member_id AND tr.topic_id = t.id)
), ordinals AS (
    SELECT q.*, (
        SELECT count(*) FROM messages m, nil WHERE m.organization_id = o AND m.channel_id = q.channel_id
            AND COALESCE(m.topic_id, nil.id) = q.scope_id AND NOT m.deleted AND m.seq <= q.read_seq
    ) - (
        SELECT COALESCE(sum(delta), 0) FROM message_count_corrections c WHERE c.organization_id = o
            AND c.channel_id = q.channel_id AND c.scope_id = q.scope_id AND c.seq <= q.read_seq
    ) AS expected_ordinal, (
        SELECT count(*) FROM messages m, nil WHERE m.organization_id = o AND m.channel_id = q.channel_id
            AND COALESCE(m.topic_id, nil.id) = q.scope_id AND NOT m.deleted AND m.seq <= q.read_seq AND m.sender = q.member_id
    ) - (
        SELECT COALESCE(sum(delta), 0) FROM message_count_corrections c WHERE c.organization_id = o
            AND c.channel_id = q.channel_id AND c.scope_id = q.scope_id AND c.seq <= q.read_seq AND c.sender = q.member_id
    ) AS expected_own
    FROM positions q
)
SELECT 'appended', e.channel_id, e.scope_id, e.member_id, e.n, COALESCE(k.appended, 0)
FROM expected_appended e LEFT JOIN message_append_counts k ON k.organization_id = o AND k.channel_id = e.channel_id
    AND k.scope_id = e.scope_id AND k.member_id = e.member_id
WHERE e.n IS DISTINCT FROM COALESCE(k.appended, 0)
UNION ALL
SELECT 'appended', k.channel_id, k.scope_id, k.member_id, 0, k.appended FROM message_append_counts k
WHERE k.organization_id = o AND k.appended <> 0 AND NOT EXISTS (SELECT 1 FROM expected_appended e
    WHERE e.channel_id = k.channel_id AND e.scope_id = k.scope_id AND e.member_id = k.member_id)
UNION ALL
SELECT 'ordinal', channel_id, scope_id, member_id, expected_ordinal, read_ordinal FROM ordinals WHERE expected_ordinal <> read_ordinal
UNION ALL
SELECT 'own_ordinal', channel_id, scope_id, member_id, expected_own, read_own_ordinal FROM ordinals WHERE expected_own <> read_own_ordinal
UNION ALL
SELECT 'mention', mm.channel_id, mm.message_id, mm.member_id, NULL, NULL
FROM message_mentions mm JOIN messages m ON m.organization_id = mm.organization_id AND m.id = mm.message_id
WHERE mm.organization_id = o
    AND (mm.seq, mm.topic_id, mm.counted) IS DISTINCT FROM (m.seq, m.topic_id, m.sender <> mm.member_id AND NOT m.deleted)
UNION ALL
-- Counts are bounded by the committed counter only if nothing lies above it.
SELECT 'above_counter', m.channel_id, m.id, m.sender, COALESCE(s.seq, 0), m.seq
FROM messages m LEFT JOIN channel_message_sequences s ON s.organization_id = m.organization_id AND s.channel_id = m.channel_id
WHERE m.organization_id = o AND m.seq > COALESCE(s.seq, 0)
UNION ALL
SELECT 'position_above_counter', q.channel_id, q.scope_id, q.member_id, COALESCE(s.seq, 0), q.read_seq
FROM positions q LEFT JOIN channel_message_sequences s ON s.organization_id = o AND s.channel_id = q.channel_id
WHERE q.read_seq > COALESCE(s.seq, 0)
$$;

DO $$
DECLARE bad record;
BEGIN
    SELECT o.organization_id, x.* INTO bad FROM organizations o, message_counts_check(o.organization_id) x LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'A3 count backfill does not match: %', bad;
    END IF;
END $$;
