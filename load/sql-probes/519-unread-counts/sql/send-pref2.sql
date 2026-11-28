-- Successful fresh sends in the same SQL-only workload as send-current.sql.
-- Counter, Topic and Message statements mirror log.rs, topics.rs and send/admitted.rs.
CREATE OR REPLACE FUNCTION proto_send(c int, u int, in_topic boolean, mention boolean) RETURNS void LANGUAGE plpgsql AS $$
DECLARE org uuid := '00000000-0000-4000-8000-00000000000a'; ch uuid := md5('chan-'||c)::uuid;
        snd uuid := md5('user-'||u)::uuid; s bigint; tid uuid; topic_name text; mid uuid;
BEGIN
  INSERT INTO channel_message_sequences (organization_id, channel_id, seq)
    VALUES (org, ch, 1)
    ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = channel_message_sequences.seq + 1
    RETURNING seq INTO s;
  IF in_topic THEN
    topic_name := 'topic '||(s % 200);
    INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count)
      VALUES (org, ch, gen_random_uuid(), topic_name, s, s, 1)
      ON CONFLICT (organization_id, channel_id, name_key) DO NOTHING;
    SELECT id INTO STRICT tid FROM topics
      WHERE organization_id = org AND channel_id = ch AND name_key = lower(topic_name COLLATE "C");
  END IF;
  INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id,
      reply_to_id, reply_root_id)
    VALUES (org, gen_random_uuid(), ch, s, snd, gen_random_uuid(), 'message body '||s, tid, NULL, NULL)
    ON CONFLICT (organization_id, sender, client_message_id) DO NOTHING
    RETURNING id INTO STRICT mid;
  IF mention THEN
    INSERT INTO message_mentions (organization_id, channel_id, message_id, member_id)
      SELECT org, ch, mid, unnest(ARRAY[md5('user-2')::uuid]);
  END IF;
  IF in_topic THEN
    UPDATE topics SET first_seq = COALESCE(first_seq, s), last_seq = s,
      message_count = message_count + 1
      WHERE organization_id = org AND id = tid AND last_seq IS DISTINCT FROM s;
  END IF;
END $$;
