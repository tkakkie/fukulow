-- F2 moves the cutover totals and current-image sends onto rows already written
-- by those sends. Nil rows now contain only the post-cutover unmarked appends
-- (older writers and direct SQL). In particular SQL fixtures can insert Messages
-- before their Channel sequence row exists. No fallback writer locks a sequence
-- or Topic row for counting.
SET LOCAL row_security = off;
LOCK TABLE users, channels, channel_members, channel_read_positions, topic_read_positions,
    message_mentions, message_append_counts, message_count_corrections IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE channel_message_sequences, topics, messages IN ACCESS EXCLUSIVE MODE;

ALTER TABLE channel_message_sequences ADD COLUMN main_appended bigint NOT NULL DEFAULT 0 CHECK (main_appended >= 0);
ALTER TABLE topics ADD COLUMN scope_appended bigint NOT NULL DEFAULT 0 CHECK (scope_appended >= 0);
-- Only the Send transaction supplies true. It owns the matching sequence/Topic
-- update and rolls it back if the INSERT loses idempotency or the send fails.
ALTER TABLE messages ADD COLUMN scope_append_recorded boolean NOT NULL DEFAULT false;

UPDATE channel_message_sequences s SET main_appended = k.appended
FROM message_append_counts k
WHERE (k.organization_id, k.channel_id) = (s.organization_id, s.channel_id)
    AND k.scope_id = '00000000-0000-0000-0000-000000000000'
    AND k.member_id = '00000000-0000-0000-0000-000000000000';
UPDATE topics t SET scope_appended = k.appended
FROM message_append_counts k
WHERE (k.organization_id, k.channel_id, k.scope_id) = (t.organization_id, t.channel_id, t.id)
    AND k.member_id = '00000000-0000-0000-0000-000000000000';

-- Retain any total whose destination row is absent (e.g. a fully hard-deleted
-- scope from a direct writer). The recount verifies the combined source.
DELETE FROM message_append_counts k
WHERE k.member_id = '00000000-0000-0000-0000-000000000000'
    AND ((k.scope_id = '00000000-0000-0000-0000-000000000000' AND EXISTS (
        SELECT FROM channel_message_sequences s
        WHERE (s.organization_id, s.channel_id) = (k.organization_id, k.channel_id)
    )) OR EXISTS (
        SELECT FROM topics t
        WHERE (t.organization_id, t.channel_id, t.id) = (k.organization_id, k.channel_id, k.scope_id)
            AND k.scope_id <> '00000000-0000-0000-0000-000000000000'
    ));

CREATE OR REPLACE FUNCTION message_counts_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    delta record;
BEGIN
    -- Take locks in key order across both paths, even when a key is being created
    -- in another transaction. UPDATE FROM alone has no guaranteed write order.
    FOR delta IN
        SELECT n.organization_id, n.channel_id,
            COALESCE(n.topic_id, '00000000-0000-0000-0000-000000000000') AS scope_id,
            v.member_id, count(*) AS appended
        FROM inserted_messages n
        CROSS JOIN LATERAL (VALUES (n.sender, true),
            ('00000000-0000-0000-0000-000000000000'::uuid, NOT n.scope_append_recorded)) v(member_id, needed)
        WHERE v.needed
        GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
    LOOP
        UPDATE message_append_counts k SET appended = k.appended + delta.appended
        WHERE (k.organization_id, k.channel_id, k.scope_id, k.member_id)
            = (delta.organization_id, delta.channel_id, delta.scope_id, delta.member_id);

        IF NOT FOUND THEN
            INSERT INTO message_append_counts AS k (organization_id, channel_id, scope_id, member_id, appended)
            VALUES (delta.organization_id, delta.channel_id, delta.scope_id, delta.member_id, delta.appended)
            ON CONFLICT (organization_id, channel_id, scope_id, member_id) DO UPDATE
                SET appended = k.appended + EXCLUDED.appended;
        END IF;
    END LOOP;

    INSERT INTO message_count_corrections
    SELECT organization_id, channel_id, COALESCE(topic_id, '00000000-0000-0000-0000-000000000000'), seq, id, sender, -1
    FROM inserted_messages WHERE deleted;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION message_count_ordinals(o uuid, c uuid, scope uuid, m uuid, x bigint,
    OUT ordinal bigint, OUT own_ordinal bigint) LANGUAGE plpgsql STABLE AS $$
BEGIN
    IF scope = '00000000-0000-0000-0000-000000000000' THEN
        SELECT COALESCE((SELECT s.main_appended FROM channel_message_sequences s
                WHERE s.organization_id = o AND s.channel_id = c), 0)
            + a.total - l.total + r.total, a.own - l.own + r.own INTO ordinal, own_ordinal
        FROM (SELECT COALESCE(sum(appended) FILTER (WHERE member_id = scope), 0) AS total,
                COALESCE(sum(appended) FILTER (WHERE member_id = m), 0) AS own
            FROM message_append_counts WHERE organization_id = o AND channel_id = c AND scope_id = scope AND member_id IN (scope, m)) a,
            (SELECT count(*) AS total, count(*) FILTER (WHERE sender = m) AS own FROM messages
            WHERE organization_id = o AND channel_id = c AND topic_id IS NULL AND NOT deleted AND seq > x) l,
            (SELECT COALESCE(sum(delta), 0) AS total, COALESCE(sum(delta) FILTER (WHERE sender = m), 0) AS own
            FROM message_count_corrections WHERE organization_id = o AND channel_id = c AND scope_id = scope AND seq > x) r;
    ELSE
        SELECT COALESCE((SELECT t.scope_appended FROM topics t
                WHERE t.organization_id = o AND t.channel_id = c AND t.id = scope), 0)
            + a.total - l.total + r.total, a.own - l.own + r.own INTO ordinal, own_ordinal
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

-- Keep count corrections for owner-only hard deletes; runtime retention grants stay unchanged.
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

CREATE OR REPLACE FUNCTION message_counts_check(o uuid)
RETURNS TABLE (kind text, channel_id uuid, scope_id uuid, member_id uuid, expected bigint, actual bigint)
LANGUAGE sql STABLE AS $$
WITH nil AS (SELECT '00000000-0000-0000-0000-000000000000'::uuid AS id),
changes AS (
    SELECT e.channel_id, e.scope_id, v.member_id, e.seq, e.delta
    FROM (
        SELECT m.channel_id, nil.id AS scope_id, m.sender, m.seq, 1 AS delta
        FROM messages m CROSS JOIN nil WHERE m.organization_id = o AND m.topic_id IS NULL AND NOT m.deleted
        UNION ALL
        SELECT m.channel_id, m.topic_id, m.sender, m.seq, 1
        FROM messages m WHERE m.organization_id = o AND m.topic_id IS NOT NULL AND NOT m.deleted
        UNION ALL
        SELECT c.channel_id, c.scope_id, c.sender, c.seq, -c.delta::integer
        FROM message_count_corrections c WHERE c.organization_id = o
    ) e CROSS JOIN LATERAL (VALUES (NULL::uuid), (e.sender)) v(member_id)
), expected_appended AS (
    SELECT e.channel_id, e.scope_id, COALESCE(e.member_id, nil.id) AS member_id, sum(e.delta) AS n
    FROM changes e CROSS JOIN nil GROUP BY 1, 2, 3
), stored_appended AS (
    SELECT a.channel_id, a.scope_id, a.member_id, a.appended
    FROM message_append_counts a CROSS JOIN nil WHERE a.organization_id = o AND a.member_id <> nil.id
    UNION ALL
    SELECT k.channel_id, k.scope_id, nil.id, sum(k.appended)::bigint
    FROM (
        SELECT a.channel_id, a.scope_id, a.appended
        FROM message_append_counts a CROSS JOIN nil WHERE a.organization_id = o AND a.member_id = nil.id
        UNION ALL
        SELECT s.channel_id, nil.id, s.main_appended
        FROM channel_message_sequences s CROSS JOIN nil WHERE s.organization_id = o AND s.main_appended <> 0
        UNION ALL
        SELECT t.channel_id, t.id, t.scope_appended
        FROM topics t WHERE t.organization_id = o AND t.scope_appended <> 0
    ) k CROSS JOIN nil GROUP BY 1, 2, 3
), positions AS (
    SELECT p.channel_id, nil.id AS scope_id, p.member_id, p.read_seq, p.read_ordinal, p.read_own_ordinal
    FROM channel_read_positions p CROSS JOIN nil WHERE p.organization_id = o
    UNION ALL
    SELECT p.channel_id, p.topic_id, p.member_id, p.read_seq, p.read_ordinal, p.read_own_ordinal
    FROM topic_read_positions p WHERE p.organization_id = o
    UNION ALL
    -- A missing Topic position is ordinals 0 at initial_seq.
    SELECT p.channel_id, t.id, p.member_id, p.initial_seq, 0, 0
    FROM channel_read_positions p
    JOIN topics t ON t.organization_id = p.organization_id AND t.channel_id = p.channel_id
    LEFT JOIN topic_read_positions tr ON (tr.organization_id, tr.channel_id, tr.member_id, tr.topic_id)
        = (p.organization_id, p.channel_id, p.member_id, t.id)
    WHERE p.organization_id = o AND tr.member_id IS NULL
), points AS (
    SELECT e.channel_id, e.scope_id, e.member_id, e.seq, e.delta,
        NULL::uuid AS position_member, NULL::bigint AS actual
    FROM changes e
    UNION ALL
    -- NULL groups the scope total separately from every sender, including a nil sender.
    SELECT q.channel_id, q.scope_id, v.member_id, q.read_seq, 0, q.member_id, v.actual
    FROM positions q
    CROSS JOIN LATERAL (VALUES (NULL::uuid, q.read_ordinal), (q.member_id, q.read_own_ordinal)) v(member_id, actual)
), ordinals AS (
    -- RANGE includes every change at the position's sequence, including any correction.
    SELECT p.*, sum(p.delta) OVER (
        PARTITION BY p.channel_id, p.scope_id, p.member_id ORDER BY p.seq RANGE UNBOUNDED PRECEDING
    ) AS expected
    FROM points p
)
SELECT 'appended', channel_id, scope_id, member_id, COALESCE(e.n, 0), COALESCE(k.appended, 0)
FROM expected_appended e FULL JOIN stored_appended k USING (channel_id, scope_id, member_id)
WHERE COALESCE(e.n, 0) <> COALESCE(k.appended, 0)
UNION ALL
SELECT CASE WHEN r.member_id IS NULL THEN 'ordinal' ELSE 'own_ordinal' END,
    r.channel_id, r.scope_id, r.position_member, r.expected, r.actual
FROM ordinals r WHERE r.position_member IS NOT NULL AND r.expected <> r.actual
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
        RAISE EXCEPTION 'F2 scope total backfill does not match: %', bad;
    END IF;
END $$;
