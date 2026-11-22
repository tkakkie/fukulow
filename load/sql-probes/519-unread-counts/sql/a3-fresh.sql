\set ON_ERROR_STOP on
ALTER TABLE messages SET (autovacuum_enabled = false);
INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id, created_at, deleted)
SELECT '00000000-0000-4000-8000-00000000000a', md5('msg-'||c||'-'||s)::uuid, md5('chan-'||c)::uuid, s,
       CASE WHEN s % 97 = 0 THEN md5('user-2')::uuid ELSE md5('user-'||(3 + s % 200))::uuid END,
       md5('cmid-'||c||'-'||s)::uuid, 'message body '||s,
       CASE WHEN c=1 AND s%10<7 THEN md5('topic-'||((s/10)%200))::uuid END, timestamptz '2026-11-01' + s*interval '1 second', s % 89 = 0
FROM generate_series(1,200) c, generate_series(2001,2150) s ORDER BY s, c;
UPDATE channel_message_sequences s SET seq = 2150, main_ordinal = (SELECT count(*) FROM messages m WHERE m.organization_id = s.organization_id AND m.channel_id = s.channel_id AND m.topic_id IS NULL);
UPDATE topics t SET last_seq = a.l, scope_ordinal = a.n FROM (SELECT topic_id, max(seq) l, count(*) n FROM messages WHERE topic_id IS NOT NULL GROUP BY 1) a WHERE t.id = a.topic_id;
INSERT INTO scope_sender_counts SELECT organization_id, channel_id, coalesce(topic_id,'00000000-0000-0000-0000-000000000000'), sender, count(*) FROM messages GROUP BY 1,2,3,4
ON CONFLICT (organization_id, channel_id, member_id, scope_id) DO UPDATE SET sent_ordinal = excluded.sent_ordinal;
INSERT INTO scope_count_corrections
SELECT organization_id, channel_id, coalesce(topic_id,'00000000-0000-0000-0000-000000000000'), seq, id, sender, -1 FROM messages WHERE deleted AND seq > 2000;
INSERT INTO message_mentions (organization_id, member_id, channel_id, message_id, seq, topic_id)
SELECT organization_id, md5('user-2')::uuid, channel_id, id, seq, topic_id FROM messages
WHERE seq > 2000 AND seq % 50 = 0 AND NOT deleted AND sender <> md5('user-2')::uuid;
