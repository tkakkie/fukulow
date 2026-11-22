use super::*;

// Reconstruct every Topic's position BEFORE the exclusive boundary. Current
// topics.last_seq cannot enumerate Topics that moved after W. Counts use the same
// immutable prefix. Only selected candidates fetch payloads (no per-Topic SQL).
// A scalar visibility subquery preserves one NULL access row after Member loss,
// so an empty page still distinguishes Organization loss from Channel denial.
pub(in crate::messages) fn page_sql() -> String {
    let sql = format!(
        r#"
WITH access AS MATERIALIZED (SELECT ({}) AS visible),
w AS MATERIALIZED (SELECT $5::bigint AS as_of_seq),
positions AS (
    SELECT m.topic_id, min(m.seq) AS first_seq, max(m.seq) AS last_seq, count(*) AS message_count,
        COALESCE(tr.read_seq, cr.initial_seq, w.as_of_seq) AS read_seq,
        count(*) FILTER (WHERE m.sender <> $2 AND m.seq > COALESCE(tr.read_seq, cr.initial_seq, w.as_of_seq)) AS unread_count
    FROM messages m CROSS JOIN w CROSS JOIN access
    LEFT JOIN channel_read_positions cr ON cr.organization_id = m.organization_id AND cr.channel_id = m.channel_id AND cr.member_id = $2 AND cr.membership_revision = $3
    LEFT JOIN topic_read_positions tr ON tr.organization_id = m.organization_id AND tr.channel_id = m.channel_id AND tr.topic_id = m.topic_id AND tr.member_id = $2 AND cr.channel_id IS NOT NULL
    WHERE m.organization_id = $1 AND m.channel_id = $4 AND m.topic_id IS NOT NULL AND NOT m.deleted
        AND m.seq <= w.as_of_seq AND access.visible AND ($9::uuid IS NULL OR m.topic_id = $9)
    GROUP BY m.topic_id, tr.read_seq, cr.initial_seq, w.as_of_seq
),
candidates AS (
    SELECT * FROM positions
    UNION ALL
    SELECT topic_id, seq, seq, 1::bigint, 0::bigint, 0::bigint FROM messages, w, access
    WHERE organization_id = $1 AND channel_id = $4 AND topic_id IS NULL
        AND seq <= w.as_of_seq AND access.visible AND NOT $8 AND $9::uuid IS NULL
),
page AS MATERIALIZED (
    SELECT * FROM candidates WHERE ($6::bigint IS NULL OR last_seq < $6)
    ORDER BY last_seq DESC LIMIT $7
)
SELECT access.visible, w.as_of_seq, p.first_seq, p.last_seq,
    p.message_count, p.read_seq, p.unread_count, mc.mention_unread_count, t.name, m.id, m.channel_id, m.seq, m.version, m.deleted, m.client_message_id,
    m.sender, m.body, m.topic_id, m.reply_to_id AS reply_to, m.reply_root_id,
    to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM access CROSS JOIN w LEFT JOIN page p ON true
LEFT JOIN messages m ON m.organization_id = $1 AND m.channel_id = $4 AND m.seq = p.last_seq
LEFT JOIN topics t ON t.organization_id = $1 AND t.channel_id = $4 AND t.id = p.topic_id
CROSS JOIN LATERAL (
    SELECT count(*) AS mention_unread_count FROM messages unread
    JOIN message_mentions mm ON mm.organization_id=$1 AND mm.member_id=$2
        AND mm.channel_id=$4 AND mm.message_id=unread.id
    WHERE unread.organization_id=$1 AND unread.channel_id=$4 AND unread.topic_id=p.topic_id
        AND unread.seq>p.read_seq AND unread.seq<=w.as_of_seq AND unread.sender<>$2 AND NOT unread.deleted
) mc
ORDER BY p.last_seq DESC
"#,
        channels::member_visibility_sql(false)
    );
    mentions::page_sql(&sql, "p.last_seq DESC")
}
