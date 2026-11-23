-- Emulates the send-path statements on main (search terms excluded: identical in both arms).
CREATE OR REPLACE FUNCTION proto_send(c int, u int, in_topic boolean, mention boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE org uuid := '00000000-0000-4000-8000-00000000000a'; ch uuid := md5('chan-'||c)::uuid;
        snd uuid := md5('user-'||u)::uuid; s bigint; tid uuid; mid uuid := gen_random_uuid();
BEGIN
  INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES (org, ch, 1)
    ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = channel_message_sequences.seq + 1 RETURNING seq INTO s;
  IF in_topic THEN tid := md5('topic-'||(s % 200))::uuid; END IF;
  INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id)
    VALUES (org, mid, ch, s, snd, gen_random_uuid(), 'message body '||s, tid);
  INSERT INTO channel_log (organization_id, channel_id, event_seq, kind, message_id, sender, client_message_id)
    SELECT org, ch, s, 'create', mid, snd, client_message_id FROM messages WHERE organization_id = org AND id = mid;
  IF mention THEN INSERT INTO message_mentions (organization_id, channel_id, message_id, member_id) VALUES (org, ch, mid, md5('user-2')::uuid); END IF;
  IF in_topic THEN UPDATE topics SET last_seq = s, message_count = message_count + 1 WHERE organization_id = org AND id = tid; END IF;
END $$;
