WITH unread_topics AS MATERIALIZED (
    SELECT t.organization_id, t.channel_id, t.id, t.last_seq,
        COALESCE(tr.read_seq, p.initial_seq) AS read_seq
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
CROSS JOIN LATERAL (
    SELECT count(*) AS unread_count, count(mm.message_id) AS mention_unread_count FROM messages m
    LEFT JOIN message_mentions mm ON mm.organization_id=$1 AND mm.member_id=$2
        AND mm.channel_id=m.channel_id AND mm.message_id=m.id
    WHERE p.channel_id IS NOT NULL AND m.organization_id = $1 AND m.channel_id = c.channel_id
        AND m.topic_id IS NULL AND m.seq > p.read_seq AND m.seq <= COALESCE(s.seq,0) AND m.sender <> $2
) main
CROSS JOIN LATERAL (
    SELECT COALESCE(sum(unread.unread_count), 0)::bigint AS unread_count,
        COALESCE(sum(unread.mention_unread_count), 0)::bigint AS mention_unread_count
    FROM unread_topics t
    CROSS JOIN LATERAL (
        SELECT count(*) AS unread_count, count(mm.message_id) AS mention_unread_count FROM messages m
        LEFT JOIN message_mentions mm ON mm.organization_id=$1 AND mm.member_id=$2
            AND mm.channel_id=m.channel_id AND mm.message_id=m.id
        WHERE m.organization_id = $1 AND m.channel_id = c.channel_id AND m.topic_id = t.id
            AND m.seq > t.read_seq AND m.seq <= COALESCE(s.seq,0) AND m.sender <> $2
    ) unread
    WHERE p.channel_id IS NOT NULL AND t.organization_id = $1 AND t.channel_id = c.channel_id
        AND t.last_seq > t.read_seq
) topic
