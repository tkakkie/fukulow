-- pgbench script for load/hot-latency.ts; SQL copied from plans.sql. -D ctx=1 wraps it
-- in a transaction that first sets the Organization transaction-locally (#314 helper).
-- pgbench reads every :word as a variable, so the to_char format builds its colons
-- with chr(58) (a constant, folded at planning).
-- History page of 51 before a uniformly random cursor in the hot Channel.
\set before random(52, 100000)
\if :ctx = 1
BEGIN;
SELECT set_config('fukulow.organization_id', :org::text, true);
\endif
SELECT id, channel_id, seq, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, to_char(created_at AT TIME ZONE 'UTC', replace('YYYY-MM-DD"T"HH24#MI#SS.US"Z"', '#', chr(58))) AS created_at FROM messages WHERE organization_id = :org::uuid AND channel_id = :chan::uuid AND seq <= :before::bigint ORDER BY seq DESC LIMIT 51;
\if :ctx = 1
COMMIT;
\endif
