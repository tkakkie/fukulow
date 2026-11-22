\set ON_ERROR_STOP on
SET synchronous_commit = off;
-- 1 Organization, 1,000 Members, 200 public Channels x 2,000 Messages (senders rotate over 200 Members).
-- Channel 1 also holds 200 Topics (70% of its Messages). Member 2 is measured.
INSERT INTO organizations (organization_id, name) VALUES ('00000000-0000-4000-8000-00000000000a','Org a');
INSERT INTO accounts (id, email, password_hash) SELECT md5('acct-'||g)::uuid, 'm'||g||'@a.invalid','x' FROM generate_series(1,1000) g;
INSERT INTO users (organization_id, id, name, role, account_id)
SELECT '00000000-0000-4000-8000-00000000000a', md5('user-'||g)::uuid, 'Member '||g, CASE WHEN g=1 THEN 'owner' ELSE 'member' END, md5('acct-'||g)::uuid
FROM generate_series(1,1000) g;
INSERT INTO channels (organization_id, id, name, visibility)
SELECT '00000000-0000-4000-8000-00000000000a', md5('chan-'||g)::uuid, 'channel-'||g, 'public' FROM generate_series(1,200) g;
INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count)
SELECT '00000000-0000-4000-8000-00000000000a', md5('chan-1')::uuid, md5('topic-'||t)::uuid, 'topic '||t, 1,1,1 FROM generate_series(0,199) t;
INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id, created_at)
SELECT '00000000-0000-4000-8000-00000000000a', md5('msg-'||c||'-'||s)::uuid, md5('chan-'||c)::uuid, s,
       md5('user-'||(3 + s % 200))::uuid, md5('cmid-'||c||'-'||s)::uuid, 'message body '||s,
       CASE WHEN c=1 AND s%10<7 THEN md5('topic-'||((s/10)%200))::uuid END,
       timestamptz '2026-11-01' + s*interval '1 second'
FROM generate_series(1,200) c, generate_series(1,2000) s;
UPDATE topics t SET first_seq=a.f, last_seq=a.l, message_count=a.n
FROM (SELECT topic_id, min(seq) f, max(seq) l, count(*) n FROM messages WHERE topic_id IS NOT NULL GROUP BY 1) a WHERE t.id=a.topic_id;
INSERT INTO channel_message_sequences (organization_id, channel_id, seq)
SELECT organization_id, channel_id, max(seq) FROM messages GROUP BY 1,2
ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq=excluded.seq;
-- Mentions of Member 2: every 50th Message.
INSERT INTO message_mentions (organization_id, member_id, channel_id, message_id)
SELECT organization_id, md5('user-2')::uuid, channel_id, id FROM messages WHERE seq % 50 = 0;
VACUUM ANALYZE;
-- Own Messages and deleted Messages so the exclusions are exercised.
UPDATE messages SET sender = md5('user-2')::uuid WHERE seq % 97 = 0;
UPDATE messages SET deleted = true WHERE seq % 89 = 0;
VACUUM ANALYZE messages;
