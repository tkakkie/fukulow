-- Substitutions are validated UUIDs and bounded integers supplied by the runner.
CREATE TEMP TABLE fixture_roots AS
SELECT n, n%7 replies, coalesce(sum(n%7) OVER (ORDER BY n ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::bigint previous
FROM generate_series(1,25000) n;
INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,created_at)
SELECT :'org',:'channel',md5('fk409p:'||n)::uuid,n,:'member',md5('fk409p:'||n)::uuid,
repeat('Root body ',12),'2026-11-17T00:00:00Z' FROM fixture_roots;
INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,reply_to_id,reply_root_id,created_at)
SELECT :'org',:'channel',md5('fk409p:'||s)::uuid,s,:'member',md5('fk409p:'||s)::uuid,
repeat('Reply body ',12),md5('fk409p:'||CASE WHEN k=1 THEN n ELSE s-1 END)::uuid,md5('fk409p:'||n)::uuid,'2026-11-17T00:00:00Z'
FROM fixture_roots CROSS JOIN LATERAL generate_series(1,replies) k
CROSS JOIN LATERAL (SELECT 25000+previous+k s) v;
INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,created_at)
SELECT :'org',:'channel',md5('fk409p:'||:longroot)::uuid,:longroot,:'member',md5('fk409p:'||:longroot)::uuid,
repeat('Long root ',12),'2026-11-17T00:00:00Z' WHERE :longreplies > 0;
INSERT INTO messages (organization_id,channel_id,id,seq,sender,client_message_id,body,reply_to_id,reply_root_id,created_at)
SELECT :'org',:'channel',md5('fk409p:'||(:longroot+k))::uuid,:longroot+k,:'member',md5('fk409p:'||(:longroot+k))::uuid,
repeat('Long Reply ',12),md5('fk409p:'||(:longroot+k-1))::uuid,md5('fk409p:'||:longroot)::uuid,'2026-11-17T00:00:00Z'
FROM generate_series(1,:longreplies) k;
INSERT INTO channel_message_sequences (organization_id,channel_id,seq) VALUES (:'org',:'channel',:total);
VACUUM (ANALYZE) messages;
ANALYZE channel_message_sequences;
