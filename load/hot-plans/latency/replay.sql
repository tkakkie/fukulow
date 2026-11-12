-- pgbench script for load/hot-latency.ts; SQL copied from plans.sql. -D ctx=1 wraps it
-- in a transaction that first sets the Organization transaction-locally (#314 helper).
-- pgbench reads every :word as a variable, so the to_char format builds its colons
-- with chr(58) (a constant, folded at planning).
-- Replay of 50 after a uniformly random cursor in the hot Channel, up to the watermark.
\set after random(0, 99950)
\if :ctx = 1
BEGIN;
SELECT set_config('fukulow.organization_id', :org::text, true);
\endif
WITH access AS MATERIALIZED (SELECT (SELECT visible FROM (SELECT u.id, u.membership_revision, EXISTS (SELECT 1 FROM channels c WHERE c.organization_id = :org::uuid AND c.id = :chan::uuid AND ((c.visibility = 'public' AND u.role IN ('owner','admin','member')) OR (u.role IN ('owner','admin','member','guest') AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision)))) AS visible FROM (SELECT id, membership_revision, role FROM users WHERE organization_id = :org::uuid AND deactivated_at IS NULL AND id = :member::uuid AND membership_revision = 0) u) visibility) AS visible)
SELECT access.visible, m.* FROM access LEFT JOIN LATERAL (
    SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, to_char(created_at AT TIME ZONE 'UTC', replace('YYYY-MM-DD"T"HH24#MI#SS.US"Z"', '#', chr(58))) AS created_at
    FROM messages WHERE organization_id = :org::uuid AND channel_id = :chan::uuid AND seq > :after::bigint AND seq <= 100000 AND access.visible
    ORDER BY seq LIMIT 50
) m ON true ORDER BY m.seq;
\if :ctx = 1
COMMIT;
\endif
