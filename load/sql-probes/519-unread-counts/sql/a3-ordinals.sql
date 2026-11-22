\set ON_ERROR_STOP on
-- What mark-read would write: ordinal at x = counter now - appended in (x, W]; own likewise.
UPDATE channel_read_positions p SET
  read_ordinal = s.main_ordinal - (SELECT count(*) FROM messages m WHERE m.organization_id = p.organization_id AND m.channel_id = p.channel_id AND m.topic_id IS NULL AND m.seq > p.read_seq AND m.seq <= s.seq),
  read_own_ordinal = COALESCE((SELECT sent_ordinal FROM scope_sender_counts k WHERE k.organization_id = p.organization_id AND k.channel_id = p.channel_id AND k.member_id = p.member_id AND k.scope_id = '00000000-0000-0000-0000-000000000000'), 0)
    - (SELECT count(*) FROM messages m WHERE m.organization_id = p.organization_id AND m.channel_id = p.channel_id AND m.topic_id IS NULL AND m.sender = p.member_id AND m.seq > p.read_seq AND m.seq <= s.seq)
FROM channel_message_sequences s WHERE s.organization_id = p.organization_id AND s.channel_id = p.channel_id AND p.member_id = md5('user-2')::uuid;
UPDATE topic_read_positions p SET
  read_ordinal = t.scope_ordinal - (SELECT count(*) FROM messages m WHERE m.organization_id = p.organization_id AND m.channel_id = p.channel_id AND m.topic_id = p.topic_id AND m.seq > p.read_seq),
  read_own_ordinal = COALESCE((SELECT sent_ordinal FROM scope_sender_counts k WHERE k.organization_id = p.organization_id AND k.channel_id = p.channel_id AND k.member_id = p.member_id AND k.scope_id = p.topic_id), 0)
    - (SELECT count(*) FROM messages m WHERE m.organization_id = p.organization_id AND m.channel_id = p.channel_id AND m.topic_id = p.topic_id AND m.sender = p.member_id AND m.seq > p.read_seq)
FROM topics t WHERE t.organization_id = p.organization_id AND t.id = p.topic_id AND p.member_id = md5('user-2')::uuid;
