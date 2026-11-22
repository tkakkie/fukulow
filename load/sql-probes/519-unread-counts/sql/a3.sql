WITH unread_topics AS MATERIALIZED (
    SELECT t.organization_id, t.channel_id, t.id, t.last_seq, t.scope_ordinal,
        COALESCE(tr.read_seq, p.initial_seq) AS read_seq,
        tr.read_ordinal, tr.read_own_ordinal
    FROM topics t
    JOIN channel_read_positions p ON p.organization_id = $1 AND p.member_id = $2
        AND p.membership_revision = $3 AND p.channel_id = t.channel_id
    LEFT JOIN topic_read_positions tr ON tr.organization_id = $1 AND tr.channel_id = t.channel_id
        AND tr.member_id = $2 AND tr.topic_id = t.id
    WHERE t.organization_id = $1 AND t.channel_id = ANY($4)
        AND t.last_seq > COALESCE(tr.read_seq, p.initial_seq)
)
SELECT c.channel_id, COALESCE(s.seq, 0) AS as_of_seq,
    COALESCE(p.read_seq, s.seq, 0) AS read_seq,
    p.channel_id IS NULL AS missing_position,
    main.unread_count AS main_unread_count,
    main.unread_count + topic.unread_count AS unread_count,
    main.mention_unread_count AS main_mention_unread_count,
    main.mention_unread_count + topic.mention_unread_count AS mention_unread_count
FROM unnest($4::uuid[]) c(channel_id)
LEFT JOIN channel_read_positions p ON p.organization_id = $1 AND p.member_id = $2
    AND p.membership_revision = $3 AND p.channel_id = c.channel_id
LEFT JOIN channel_message_sequences s ON s.organization_id = $1 AND s.channel_id = c.channel_id
-- Unread in (read_seq, W] = appended there - own appended there + other senders' corrections there.
-- The ordinal at W is on the counter row; the ordinals at read_seq are stored on the position.
CROSS JOIN LATERAL (
    SELECT CASE WHEN p.channel_id IS NULL OR COALESCE(s.seq, 0) <= p.read_seq THEN 0 ELSE
        s.main_ordinal - p.read_ordinal
      - COALESCE((SELECT k.sent_ordinal FROM scope_sender_counts k WHERE k.organization_id = $1 AND k.channel_id = c.channel_id
            AND k.member_id = $2 AND k.scope_id = '00000000-0000-0000-0000-000000000000'), 0)
      + p.read_own_ordinal
      + (SELECT COALESCE(sum(x.delta), 0) FROM scope_count_corrections x WHERE x.organization_id = $1 AND x.channel_id = c.channel_id
            AND x.scope_id = '00000000-0000-0000-0000-000000000000' AND x.seq > p.read_seq AND x.seq <= s.seq AND x.sender <> $2)
    END AS unread_count,
    CASE WHEN p.channel_id IS NULL OR COALESCE(s.seq, 0) <= p.read_seq THEN 0 ELSE
        (SELECT count(*) FROM message_mentions mm
         WHERE mm.organization_id = $1 AND mm.member_id = $2 AND mm.channel_id = c.channel_id
           AND mm.topic_id IS NULL AND mm.seq > p.read_seq AND mm.seq <= s.seq)
    END AS mention_unread_count
    OFFSET 0
) main
CROSS JOIN LATERAL (
    SELECT COALESCE(sum(tc.unread_count), 0)::bigint AS unread_count,
        COALESCE(sum(tc.mention_unread_count), 0)::bigint AS mention_unread_count
    FROM unread_topics t
    CROSS JOIN LATERAL (
        SELECT
            t.scope_ordinal
          -- A missing Topic position falls back to counting the range (rare: positions are created on access).
          - COALESCE(t.read_ordinal, t.scope_ordinal - (SELECT count(*) FROM messages m WHERE m.organization_id = $1
                AND m.channel_id = c.channel_id AND m.topic_id = t.id AND m.seq > t.read_seq AND m.seq <= s.seq))
          - COALESCE((SELECT k.sent_ordinal FROM scope_sender_counts k WHERE k.organization_id = $1 AND k.channel_id = c.channel_id
                AND k.member_id = $2 AND k.scope_id = t.id), 0)
          + COALESCE(t.read_own_ordinal, COALESCE((SELECT k.sent_ordinal FROM scope_sender_counts k WHERE k.organization_id = $1
                AND k.channel_id = c.channel_id AND k.member_id = $2 AND k.scope_id = t.id), 0)
                - (SELECT count(*) FROM messages m WHERE m.organization_id = $1 AND m.channel_id = c.channel_id
                AND m.topic_id = t.id AND m.sender = $2 AND m.seq > t.read_seq AND m.seq <= s.seq))
          + (SELECT COALESCE(sum(x.delta), 0) FROM scope_count_corrections x WHERE x.organization_id = $1 AND x.channel_id = c.channel_id
                AND x.scope_id = t.id AND x.seq > t.read_seq AND x.seq <= s.seq AND x.sender <> $2)
            AS unread_count,
            (SELECT count(*) FROM message_mentions mm
             WHERE mm.organization_id = $1 AND mm.member_id = $2 AND mm.channel_id = c.channel_id
               AND mm.topic_id = t.id AND mm.seq > t.read_seq AND mm.seq <= s.seq)
            AS mention_unread_count
        OFFSET 0
    ) tc
    WHERE p.channel_id IS NOT NULL AND t.organization_id = $1 AND t.channel_id = c.channel_id
        AND COALESCE(s.seq, 0) > t.read_seq
) topic
