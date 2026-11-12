-- #314 EXPLAIN (ANALYZE, BUFFERS) of the hot queries, copied from the server SQL
-- at the measured commit. Run as fukulow_app on the seed.sql dataset; writes are
-- rolled back. Run twice and keep the second (warm) output. `-v generic=1`
-- forces generic plans. Without it, the auto.* sections run timeline and Unread
-- counts six times in this session and explain the next (default plan_cache_mode,
-- as a pooled SQLx connection sees it after five executions).
\set ON_ERROR_STOP on
\pset pager off
\if :{?generic}
SET plan_cache_mode = force_generic_plan;
\endif
SELECT '00000000-0000-4000-8000-00000000000a' AS org, md5('user-a-2')::uuid AS member,
       md5('chan-a-1')::uuid AS chan, md5('topic-a-1-7')::uuid AS topic,
       md5('msg-a-1-99990')::uuid AS parent \gset
SELECT array_agg(md5('user-a-' || g)::uuid)::text AS cands, array_agg(0::bigint)::text AS revs,
       array_agg('00000000-0000-4000-8000-00000000000a'::uuid)::text AS orgs,
       array_agg(md5('chan-a-1')::uuid)::text AS chans
FROM generate_series(1, 1024) g \gset
SELECT array_agg(id ORDER BY id)::text AS visible_ids FROM channels
WHERE organization_id = :'org' AND (visibility = 'public' OR id IN (
  SELECT channel_id FROM channel_members WHERE organization_id = :'org' AND member_id = :'member')) \gset
\set E 'EXPLAIN (ANALYZE, BUFFERS)'
\set ROW 'id, channel_id, seq, client_message_id, sender, body, topic_id, reply_to_id AS reply_to, reply_root_id, to_char(created_at AT TIME ZONE ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"'') AS created_at'
\set ACTIVE 'SELECT id, membership_revision, role FROM users WHERE organization_id = $1 AND deactivated_at IS NULL'
\set VISIBLE '(c.visibility = ''public'' AND u.role IN (''owner'',''admin'',''member'')) OR (u.role IN (''owner'',''admin'',''member'',''guest'') AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.organization_id = c.organization_id AND cm.channel_id = c.id AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision))'
\set VIS 'SELECT visible FROM (SELECT u.id, u.membership_revision, EXISTS (SELECT 1 FROM channels c WHERE c.organization_id = $1 AND c.id = $4 AND (' :VISIBLE ')) AS visible FROM (' :ACTIVE ' AND id = $2 AND membership_revision = $3) u) visibility'

\echo '### auth'
PREPARE auth(bytea, uuid) AS SELECT s.account_id, u.id, u.name, u.role, o.name, u.membership_revision FROM account_sessions s LEFT JOIN users u ON u.account_id = s.account_id AND u.organization_id = $2 AND u.deactivated_at IS NULL LEFT JOIN organizations o ON o.organization_id = u.organization_id WHERE s.token_hash = $1 AND s.expires_at > now();
:E EXECUTE auth(sha256('hot-plans-session'), :'org');

\echo '### vis'
PREPARE vis(uuid, uuid, bigint, uuid) AS :VIS;
:E EXECUTE vis(:'org', :'member', 0, :'chan');

\echo '### watermark.shared_lock (own transaction)'
PREPARE shared_lock(uuid, uuid) AS WITH timeout AS MATERIALIZED (SELECT set_config('lock_timeout', '10s', true), set_config('transaction_timeout', '8s', true)) SELECT pg_advisory_xact_lock_shared(hashtextextended($1::uuid::text || '/' || $2::uuid::text, 135)) FROM timeout;
BEGIN ISOLATION LEVEL READ COMMITTED;
:E EXECUTE shared_lock(:'org', :'chan');
COMMIT;
\echo '### watermark'
PREPARE watermark(uuid, uuid) AS SELECT seq FROM channel_message_sequences WHERE organization_id = $1 AND channel_id = $2;
:E EXECUTE watermark(:'org', :'chan');

\echo '## send (one Topic Message, rolled back)'
PREPARE member_lock(uuid, uuid, bigint) AS SELECT role FROM (:ACTIVE AND id = $2 AND membership_revision = $3 FOR SHARE) u;
PREPARE channel_public(uuid, uuid) AS SELECT visibility = 'public' FROM channels WHERE organization_id=$1 AND id=$2;
PREPARE existing(uuid, uuid, uuid) AS SELECT :ROW FROM messages WHERE organization_id = $1 AND sender = $2 AND client_message_id = $3;
PREPARE reply_parent(uuid, uuid, uuid) AS SELECT :ROW FROM messages WHERE organization_id=$1 AND channel_id=$2 AND id=$3;
PREPARE next_seq(uuid, uuid) AS INSERT INTO channel_message_sequences (organization_id, channel_id, seq) VALUES ($1, $2, 1) ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = channel_message_sequences.seq + 1 RETURNING seq;
PREPARE topic_join(uuid, uuid, uuid, text, bigint) AS INSERT INTO topics (organization_id, channel_id, id, name, first_seq, last_seq, message_count) VALUES ($1, $2, $3, $4, $5, $5, 1) ON CONFLICT (organization_id, channel_id, name_key) DO NOTHING;
PREPARE topic_id(uuid, uuid, text) AS SELECT id FROM topics WHERE organization_id = $1 AND channel_id = $2 AND name_key = lower($3 COLLATE "C");
PREPARE insert_message(uuid, uuid, uuid, bigint, uuid, uuid, text, uuid, uuid, uuid) AS INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body, topic_id, reply_to_id, reply_root_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (organization_id, sender, client_message_id) DO NOTHING RETURNING :ROW;
PREPARE topic_record(uuid, uuid, bigint) AS UPDATE topics SET last_seq = $3, message_count = message_count + 1 WHERE organization_id = $1 AND id = $2 AND last_seq <> $3;
BEGIN;
\echo '### send.member_lock'
:E EXECUTE member_lock(:'org', :'member', 0);
\echo '### send.channel_public'
:E EXECUTE channel_public(:'org', :'chan');
\echo '### send.existing'
:E EXECUTE existing(:'org', :'member', gen_random_uuid());
\echo '### send.reply_parent'
:E EXECUTE reply_parent(:'org', :'chan', :'parent');
\echo '### send.channel_lock'
PREPARE channel_lock(uuid, uuid) AS WITH timeout AS MATERIALIZED (SELECT set_config('lock_timeout', '10s', true), set_config('transaction_timeout', '8s', true)) SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text || '/' || $2::uuid::text, 135)) FROM timeout;
:E EXECUTE channel_lock(:'org', :'chan');
\echo '### send.next_seq'
:E EXECUTE next_seq(:'org', :'chan');
\echo '### send.topic_join'
:E EXECUTE topic_join(:'org', :'chan', gen_random_uuid(), 'topic 7', 100001);
\echo '### send.topic_id'
:E EXECUTE topic_id(:'org', :'chan', 'topic 7');
\echo '### send.insert_message'
:E EXECUTE insert_message(:'org', gen_random_uuid(), :'chan', 100001, :'member', gen_random_uuid(), 'hot plan body', :'topic', NULL, NULL);
\echo '### send.topic_record'
:E EXECUTE topic_record(:'org', :'topic', 100001);
ROLLBACK;

\echo '### history.latest'
PREPARE history(uuid, uuid, bigint, bigint) AS SELECT :ROW FROM messages WHERE organization_id = $1 AND channel_id = $2 AND seq <= $3 ORDER BY seq DESC LIMIT $4;
:E EXECUTE history(:'org', :'chan', 9223372036854775807, 51);
\echo '### history.before_old'
:E EXECUTE history(:'org', :'chan', 5000, 51);

\echo '### timeline.latest'
PREPARE timeline(uuid, uuid, bigint, uuid, bigint, bigint, bigint, boolean, uuid) AS
WITH access AS MATERIALIZED (SELECT (:VIS) AS visible),
w AS MATERIALIZED (SELECT $5::bigint AS as_of_seq),
positions AS (
    SELECT m.topic_id, min(m.seq) AS first_seq, max(m.seq) AS last_seq, count(*) AS message_count,
        COALESCE(tr.read_seq, cr.initial_seq, w.as_of_seq) AS read_seq,
        count(*) FILTER (WHERE m.sender <> $2 AND m.seq > COALESCE(tr.read_seq, cr.initial_seq, w.as_of_seq)) AS unread_count
    FROM messages m CROSS JOIN w CROSS JOIN access
    LEFT JOIN channel_read_positions cr ON cr.organization_id = m.organization_id AND cr.channel_id = m.channel_id AND cr.member_id = $2
    LEFT JOIN topic_read_positions tr ON tr.organization_id = m.organization_id AND tr.channel_id = m.channel_id AND tr.topic_id = m.topic_id AND tr.member_id = $2
    WHERE m.organization_id = $1 AND m.channel_id = $4 AND m.topic_id IS NOT NULL
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
    p.message_count, p.read_seq, p.unread_count, t.name, m.id, m.channel_id, m.seq, m.client_message_id,
    m.sender, m.body, m.topic_id, m.reply_to_id AS reply_to, m.reply_root_id,
    to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM access CROSS JOIN w LEFT JOIN page p ON true
LEFT JOIN messages m ON m.organization_id = $1 AND m.channel_id = $4 AND m.seq = p.last_seq
LEFT JOIN topics t ON t.organization_id = $1 AND t.channel_id = $4 AND t.id = p.topic_id
ORDER BY p.last_seq DESC;
:E EXECUTE timeline(:'org', :'member', 0, :'chan', 100000, NULL, 51, false, NULL);
\echo '### timeline.topic'
:E EXECUTE timeline(:'org', :'member', 0, :'chan', 100000, NULL, 2, true, :'topic');

\echo '### replay'
PREPARE replay(uuid, uuid, bigint, uuid, bigint, bigint, bigint) AS
WITH access AS MATERIALIZED (SELECT (:VIS) AS visible)
SELECT access.visible,m.* FROM access LEFT JOIN LATERAL (
    SELECT id,channel_id,seq,client_message_id,sender,body,topic_id,reply_to_id AS reply_to,reply_root_id,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
    FROM messages WHERE organization_id=$1 AND channel_id=$4 AND seq>$5 AND seq<=$6 AND access.visible
    ORDER BY seq LIMIT $7
) m ON true ORDER BY m.seq;
:E EXECUTE replay(:'org', :'member', 0, :'chan', 99900, 100000, 50);

\echo '### fanout.member_access_1024'
PREPARE member_access(uuid, uuid, uuid[], bigint[]) AS SELECT v.id,v.membership_revision,v.visible FROM (SELECT u.id, u.membership_revision, EXISTS (SELECT 1 FROM channels c WHERE c.organization_id = $1 AND c.id = $2 AND (:VISIBLE)) AS visible FROM (:ACTIVE AND id = ANY($3)) u) v JOIN UNNEST($3::uuid[], $4::bigint[]) candidate(id,revision) ON v.id=candidate.id AND v.membership_revision=candidate.revision;
:E EXECUTE member_access(:'org', :'chan', :'cands', :'revs');

\echo '### fanout.access_rows_1024'
PREPARE access_rows(uuid[], uuid[], bigint[], uuid[]) AS SELECT COALESCE((c.visibility='public' AND u.role IN ('owner','admin','member')) OR (u.role IN ('owner','admin','member','guest') AND cm.grant_id IS NOT NULL), false),
        CASE WHEN c.visibility='public' AND u.role IN ('owner','admin','member') THEN NULL ELSE cm.grant_id END, u.id IS NOT NULL
        FROM unnest($1::uuid[], $2::uuid[], $3::bigint[], $4::uuid[]) WITH ORDINALITY r(organization_id,member_id,revision,channel_id,n)
        LEFT JOIN (SELECT organization_id,id,name,role,membership_revision FROM users WHERE deactivated_at IS NULL) u ON u.organization_id=r.organization_id AND u.id=r.member_id AND u.membership_revision=r.revision
        LEFT JOIN channels c ON c.organization_id=r.organization_id AND c.id=r.channel_id AND u.id IS NOT NULL
        LEFT JOIN channel_members cm ON cm.organization_id=c.organization_id AND cm.channel_id=c.id AND cm.member_id=u.id AND cm.membership_revision=u.membership_revision
        ORDER BY r.n;
:E EXECUTE access_rows(:'orgs', :'cands', :'revs', :'chans');

\echo '### unread.visible_list'
PREPARE visible_list(uuid, uuid, bigint) AS SELECT c.id, c.name, c.visibility, u.role FROM (:ACTIVE) u LEFT JOIN channels c ON c.organization_id = $1 AND (:VISIBLE) WHERE u.id = $2 AND u.membership_revision = $3 ORDER BY lower(c.name COLLATE "C"), c.id;
:E EXECUTE visible_list(:'org', :'member', 0);

\echo '### unread.list_counts'
PREPARE list_counts(uuid, uuid, bigint, uuid[]) AS
SELECT c.channel_id, COALESCE(s.seq, 0) AS as_of_seq,
    COALESCE(p.read_seq, s.seq, 0) AS read_seq,
    p.channel_id IS NULL AS missing_position,
    main.unread_count AS main_unread_count,
    main.unread_count + topic.unread_count AS unread_count
FROM unnest($4::uuid[]) c(channel_id)
LEFT JOIN channel_read_positions p ON p.organization_id = $1 AND p.member_id = $2
    AND p.membership_revision = $3 AND p.channel_id = c.channel_id
LEFT JOIN channel_message_sequences s ON s.organization_id = $1 AND s.channel_id = c.channel_id
CROSS JOIN LATERAL (
    SELECT count(*) AS unread_count FROM messages m
    WHERE p.channel_id IS NOT NULL AND m.organization_id = $1 AND m.channel_id = c.channel_id
        AND m.topic_id IS NULL AND m.seq > p.read_seq AND m.sender <> $2
) main
CROSS JOIN LATERAL (
    SELECT COALESCE(sum(unread.unread_count), 0)::bigint AS unread_count
    FROM topics t
    LEFT JOIN topic_read_positions tr ON tr.organization_id = $1 AND tr.channel_id = c.channel_id
        AND tr.member_id = $2 AND tr.topic_id = t.id
    CROSS JOIN LATERAL (
        SELECT count(*) AS unread_count FROM messages m
        WHERE m.organization_id = $1 AND m.channel_id = c.channel_id AND m.topic_id = t.id
            AND m.seq > COALESCE(tr.read_seq, p.initial_seq) AND m.sender <> $2
    ) unread
    WHERE p.channel_id IS NOT NULL AND t.organization_id = $1 AND t.channel_id = c.channel_id
        AND t.last_seq > COALESCE(tr.read_seq, p.initial_seq)
) topic;
:E EXECUTE list_counts(:'org', :'member', 0, :'visible_ids');

\echo '## mark-read (rolled back)'
PREPARE position_lock(uuid, uuid, uuid, bigint) AS SELECT initial_seq FROM channel_read_positions WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 AND membership_revision=$4 FOR UPDATE;
PREPARE mark_channel(uuid, uuid, uuid, bigint) AS UPDATE channel_read_positions SET read_seq=GREATEST(read_seq,$4) WHERE organization_id=$1 AND channel_id=$2 AND member_id=$3 RETURNING read_seq;
PREPARE topic_exists(uuid, uuid, uuid) AS SELECT EXISTS (SELECT 1 FROM topics WHERE organization_id=$1 AND channel_id=$2 AND id=$3);
PREPARE mark_topic(uuid, uuid, uuid, uuid, bigint) AS INSERT INTO topic_read_positions (organization_id,channel_id,member_id,topic_id,read_seq) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id,channel_id,member_id,topic_id) DO UPDATE SET read_seq=GREATEST(topic_read_positions.read_seq,EXCLUDED.read_seq) RETURNING read_seq;
BEGIN;
SET LOCAL lock_timeout = '5s';
\echo '### read.position_lock'
:E EXECUTE position_lock(:'org', :'chan', :'member', 0);
\echo '### read.mark_channel'
:E EXECUTE mark_channel(:'org', :'chan', :'member', 100000);
\echo '### read.topic_exists'
:E EXECUTE topic_exists(:'org', :'chan', :'topic');
\echo '### read.mark_topic'
:E EXECUTE mark_topic(:'org', :'chan', :'member', :'topic', 100000);
ROLLBACK;

\if :{?generic}
\else
\o /dev/null
EXECUTE timeline(:'org', :'member', 0, :'chan', 100000, NULL, 51, false, NULL);
EXECUTE timeline(:'org', :'member', 0, :'chan', 100000, NULL, 51, false, NULL);
EXECUTE timeline(:'org', :'member', 0, :'chan', 100000, NULL, 51, false, NULL);
EXECUTE timeline(:'org', :'member', 0, :'chan', 100000, NULL, 51, false, NULL);
EXECUTE timeline(:'org', :'member', 0, :'chan', 100000, NULL, 51, false, NULL);
EXECUTE timeline(:'org', :'member', 0, :'chan', 100000, NULL, 51, false, NULL);
EXECUTE list_counts(:'org', :'member', 0, :'visible_ids');
EXECUTE list_counts(:'org', :'member', 0, :'visible_ids');
EXECUTE list_counts(:'org', :'member', 0, :'visible_ids');
EXECUTE list_counts(:'org', :'member', 0, :'visible_ids');
EXECUTE list_counts(:'org', :'member', 0, :'visible_ids');
EXECUTE list_counts(:'org', :'member', 0, :'visible_ids');
\o
\echo '### auto.timeline'
:E EXECUTE timeline(:'org', :'member', 0, :'chan', 100000, NULL, 51, false, NULL);
\echo '### auto.list_counts'
:E EXECUTE list_counts(:'org', :'member', 0, :'visible_ids');
\endif
