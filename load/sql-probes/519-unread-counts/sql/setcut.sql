-- usage: -v cut=N  (measured Member has N unread per scope at the tail)
UPDATE channel_read_positions p SET read_seq = greatest(0, s.seq - :cut)
FROM channel_message_sequences s WHERE s.channel_id = p.channel_id AND p.member_id = md5('user-2')::uuid;
DELETE FROM topic_read_positions WHERE member_id = md5('user-2')::uuid;
INSERT INTO topic_read_positions (organization_id, channel_id, member_id, topic_id, read_seq)
SELECT t.organization_id, t.channel_id, md5('user-2')::uuid, t.id, least(t.last_seq, greatest(0, s.seq - :cut))
FROM topics t JOIN channel_message_sequences s ON s.channel_id = t.channel_id;
