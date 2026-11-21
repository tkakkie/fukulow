SELECT hit.message_id,
    to_char(hit.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM unnest($2::uuid[]) AS scope(channel_id)
CROSS JOIN LATERAL (
    SELECT t.message_id, t.created_at
    FROM message_search_terms t
    CROSS JOIN LATERAL (
        SELECT 1
        FROM messages m
        WHERE m.organization_id = $1 AND m.id = t.message_id
            AND m.channel_id = t.channel_id AND m.created_at = t.created_at
            AND NOT m.deleted
            AND NOT EXISTS (
                WITH normalized AS MATERIALIZED (SELECT public.fukulow_search_normalize(m.body) AS body)
                SELECT 1 FROM normalized CROSS JOIN unnest($4::text[]) AS query(token)
                WHERE strpos(normalized.body COLLATE pg_catalog."C", token) = 0
            )
        OFFSET 0
    ) matched
    WHERE t.organization_id = $1 AND t.channel_id = scope.channel_id
        AND t.term = $3 COLLATE pg_catalog."C"
        AND t.created_at >= $5::text::timestamptz
        AND (t.created_at, t.message_id) < ($6::text::timestamptz, $7::uuid)
    ORDER BY t.created_at DESC, t.message_id DESC
    LIMIT $8 + 1
) hit
ORDER BY hit.created_at DESC, hit.message_id DESC
LIMIT $8 + 1;
