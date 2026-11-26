use crate::auth::Auth;
use sqlx::{PgConnection, Row};
use std::collections::HashMap;
use uuid::Uuid;

// #519 A3: no count reads `messages`. Per scope, Unread in (read_seq, S] is
// (appended - own appended) - (read_ordinal - read_own_ordinal) + other senders'
// corrections in the range (migration 202611221100 has the identity). Mentions
// are a range on the counted partial index. The counter and the counts commit
// atomically, so this snapshot's counts are exactly bounded by its counter.
// A Topic with last_seq at or below its position has no live Message above it;
// a missing Topic position is ordinals 0 at initial_seq. Each scope is clamped at
// 0 and count_drift reports a negative raw value, which the identity rules out.
// Materialize the Member's unread Topic candidates once, rather than rescan
// every Topic under RLS per Channel. Carry the lower bound as a column: PostgreSQL
// does not recognise COALESCE as leakproof, so it stays out of RLS index quals.
pub(in crate::messages) const LIST_COUNTS_SQL: &str = r#"
WITH unread_topics AS MATERIALIZED (
    SELECT t.organization_id, t.channel_id, t.id, t.last_seq,
        COALESCE(tr.read_seq, p.initial_seq) AS read_seq,
        COALESCE(tr.read_ordinal, 0) AS read_ordinal,
        COALESCE(tr.read_own_ordinal, 0) AS read_own_ordinal
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
    GREATEST(main.unread_count, 0) AS main_unread_count,
    GREATEST(main.unread_count, 0) + topic.unread_count AS unread_count,
    main.mention_unread_count AS main_mention_unread_count,
    main.mention_unread_count + topic.mention_unread_count AS mention_unread_count,
    main.unread_count < 0 OR topic.drift AS count_drift
FROM unnest($4::uuid[]) c(channel_id)
LEFT JOIN channel_read_positions p ON p.organization_id = $1 AND p.member_id = $2
    AND p.membership_revision = $3 AND p.channel_id = c.channel_id
LEFT JOIN channel_message_sequences s ON s.organization_id = $1 AND s.channel_id = c.channel_id
CROSS JOIN LATERAL (
    SELECT CASE WHEN p.channel_id IS NULL OR COALESCE(s.seq, 0) <= p.read_seq THEN 0 ELSE
        (SELECT (COALESCE(sum(k.appended) FILTER (WHERE k.member_id = '00000000-0000-0000-0000-000000000000'), 0)
              - COALESCE(sum(k.appended) FILTER (WHERE k.member_id = $2), 0))::bigint
         FROM message_append_counts k WHERE k.organization_id = $1 AND k.channel_id = c.channel_id
            AND k.scope_id = '00000000-0000-0000-0000-000000000000'
            AND k.member_id IN ('00000000-0000-0000-0000-000000000000', $2))
        - p.read_ordinal + p.read_own_ordinal
        + (SELECT COALESCE(sum(x.delta), 0) FROM message_count_corrections x
           WHERE x.organization_id = $1 AND x.channel_id = c.channel_id
             AND x.scope_id = '00000000-0000-0000-0000-000000000000'
             AND x.seq > p.read_seq AND x.seq <= s.seq AND x.sender <> $2)
    END AS unread_count,
    CASE WHEN p.channel_id IS NULL OR COALESCE(s.seq, 0) <= p.read_seq THEN 0 ELSE
        (SELECT count(*) FROM message_mentions mm
         WHERE mm.organization_id = $1 AND mm.member_id = $2 AND mm.channel_id = c.channel_id
           AND mm.topic_id IS NULL AND mm.seq > p.read_seq AND mm.seq <= s.seq AND mm.counted)
    END AS mention_unread_count
    OFFSET 0
) main
CROSS JOIN LATERAL (
    SELECT COALESCE(sum(GREATEST(tc.unread_count, 0)), 0)::bigint AS unread_count,
        COALESCE(sum(tc.mention_unread_count), 0)::bigint AS mention_unread_count,
        COALESCE(bool_or(tc.unread_count < 0), false) AS drift
    FROM unread_topics t
    CROSS JOIN LATERAL (
        SELECT
            (SELECT (COALESCE(sum(k.appended) FILTER (WHERE k.member_id = '00000000-0000-0000-0000-000000000000'), 0)
                  - COALESCE(sum(k.appended) FILTER (WHERE k.member_id = $2), 0))::bigint
             FROM message_append_counts k WHERE k.organization_id = $1 AND k.channel_id = c.channel_id
                AND k.scope_id = t.id AND k.member_id IN ('00000000-0000-0000-0000-000000000000', $2))
            - t.read_ordinal + t.read_own_ordinal
            + (SELECT COALESCE(sum(x.delta), 0) FROM message_count_corrections x
               WHERE x.organization_id = $1 AND x.channel_id = c.channel_id AND x.scope_id = t.id
                 AND x.seq > t.read_seq AND x.seq <= s.seq AND x.sender <> $2)
            AS unread_count,
            (SELECT count(*) FROM message_mentions mm
             WHERE mm.organization_id = $1 AND mm.member_id = $2 AND mm.channel_id = c.channel_id
               AND mm.topic_id = t.id AND mm.seq > t.read_seq AND mm.seq <= s.seq AND mm.counted)
            AS mention_unread_count
        OFFSET 0
    ) tc
    WHERE p.channel_id IS NOT NULL AND t.organization_id = $1 AND t.channel_id = c.channel_id
        AND COALESCE(s.seq, 0) > t.read_seq
) topic
"#;

pub(in crate::messages) struct ListCounts {
    pub(in crate::messages) as_of_seq: i64,
    pub(in crate::messages) read_seq: i64,
    pub(in crate::messages) main_unread_count: i64,
    pub(in crate::messages) unread_count: i64,
    pub(in crate::messages) main_mention_unread_count: i64,
    pub(in crate::messages) mention_unread_count: i64,
}

pub(in crate::messages) enum MissingPositionLog {
    Emit,
    Suppress,
}

pub(in crate::messages) async fn list_counts(
    tx: &mut PgConnection,
    auth: &Auth,
    ids: &[Uuid],
    missing_position_log: MissingPositionLog,
) -> Result<HashMap<Uuid, ListCounts>, sqlx::Error> {
    let rows = sqlx::query(LIST_COUNTS_SQL)
        .bind(auth.identity.organization.organization_id)
        .bind(auth.identity.member.id)
        .bind(auth.membership_revision)
        .bind(ids)
        .fetch_all(tx)
        .await?;
    let mut counts = HashMap::new();
    for row in rows {
        if matches!(missing_position_log, MissingPositionLog::Emit)
            && row.try_get::<bool, _>("missing_position")?
        {
            tracing::error!(target: "fukulow", event = "missing_unread_position");
        }
        if row.try_get::<bool, _>("count_drift")? {
            tracing::error!(target: "fukulow", event = "unread_count_drift");
        }
        counts.insert(
            row.try_get::<Uuid, _>("channel_id")?,
            ListCounts {
                as_of_seq: row.try_get("as_of_seq")?,
                read_seq: row.try_get("read_seq")?,
                main_unread_count: row.try_get("main_unread_count")?,
                unread_count: row.try_get("unread_count")?,
                main_mention_unread_count: row.try_get("main_mention_unread_count")?,
                mention_unread_count: row.try_get("mention_unread_count")?,
            },
        );
    }
    Ok(counts)
}
