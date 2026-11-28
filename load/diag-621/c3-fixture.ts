import { channelLogSQL, prefillSQL, settleSQL } from '../slice5/fixture.ts';

export const prefillPerChannel = 100;
const relations = ['messages', 'channel_log', 'channel_message_sequences', 'message_search_terms', 'message_append_counts',
  'message_count_corrections', 'channel_read_positions', 'topic_read_positions', 'topics', 'message_mentions'];
const relationList = relations.map(table => `'public.${table}'::regclass`).join(', ');

export const disableMaintenance = relations.map(table => `ALTER TABLE public.${table} SET (autovacuum_enabled = false);
DO $$ BEGIN IF (SELECT reltoastrelid <> 0 FROM pg_class WHERE oid = 'public.${table}'::regclass) THEN
  ALTER TABLE public.${table} SET (toast.autovacuum_enabled = false);
END IF; END $$;`).join('\n');

const terms = `SELECT m.organization_id, m.channel_id, term, m.created_at, m.id AS message_id
FROM public.messages AS m
CROSS JOIN LATERAL public.fukulow_search_terms(m.body) AS terms(term)
WHERE NOT m.deleted`;
export const backfill = `INSERT INTO public.message_search_terms (organization_id, channel_id, term, created_at, message_id)
${terms};`;

export const settleFixture = (organization: string, channels: string[]) => [disableMaintenance,
  prefillSQL(organization, channels, channels.map(() => prefillPerChannel)), channelLogSQL('A', organization, channels), backfill, settleSQL].join('\n');

export const fixtureChecks = `SELECT json_build_object(
  'prefillMissing', (SELECT count(*) FROM public.messages m WHERE m.seq <= ${prefillPerChannel} AND NOT m.deleted
    AND char_length(public.fukulow_search_normalize(m.body)) >= 2 AND NOT EXISTS (
      SELECT FROM public.message_search_terms t WHERE (t.organization_id,t.channel_id,t.message_id,t.created_at)
      = (m.organization_id,m.channel_id,m.id,m.created_at))),
  'wrongTerms', (WITH expected AS (${terms} AND m.seq > ${prefillPerChannel}),
    actual AS (SELECT t.organization_id,t.channel_id,t.term,t.created_at,t.message_id
      FROM public.messages m JOIN public.message_search_terms t
        ON (m.organization_id,m.channel_id,m.id) = (t.organization_id,t.channel_id,t.message_id)
      WHERE m.seq > ${prefillPerChannel})
    SELECT count(*) FROM ((TABLE expected EXCEPT ALL TABLE actual) UNION ALL (TABLE actual EXCEPT ALL TABLE expected)) differences),
  'unreadMismatches', (SELECT count(*) FROM organizations o CROSS JOIN LATERAL message_counts_check(o.organization_id)),
  'searchHeapBytes', pg_relation_size('public.message_search_terms'),
  'searchIndexBytes', pg_indexes_size('public.message_search_terms'));`;

export const countChecks = `SELECT json_build_object(
  'messages',(SELECT count(*) FROM messages), 'counterTotal',(SELECT sum(seq) FROM channel_message_sequences),
  'log',(SELECT count(*) FROM channel_log),
  'badSequences',(SELECT count(*) FROM (
    SELECT organization_id,channel_id,count(*) AS n,min(seq) AS lo,max(seq) AS hi FROM messages GROUP BY organization_id,channel_id
  ) m FULL JOIN channel_message_sequences s USING (organization_id,channel_id)
    WHERE s.seq IS DISTINCT FROM m.n OR m.lo IS DISTINCT FROM 1::bigint OR m.hi IS DISTINCT FROM m.n),
  'nonPlain',(SELECT count(*) FROM messages WHERE topic_id IS NOT NULL OR reply_to_id IS NOT NULL OR octet_length(body) <> 17),
  'duplicateLog',(SELECT count(*) FROM (SELECT 1 FROM channel_log GROUP BY organization_id,channel_id,event_seq HAVING count(*)>1) d),
  'orphanChannels',(SELECT count(*) FROM channel_log l WHERE NOT EXISTS (SELECT 1 FROM channels c
    WHERE c.organization_id=l.organization_id AND c.id=l.channel_id)),
  'orphanSenders',(SELECT count(*) FROM channel_log l WHERE NOT EXISTS (SELECT 1 FROM users u
    WHERE u.organization_id=l.organization_id AND u.id=l.sender)),
  'missingCreates',(SELECT count(*) FROM messages m WHERE NOT EXISTS (SELECT 1 FROM channel_log l
    WHERE (l.organization_id,l.channel_id,l.event_seq,l.kind,l.message_id,l.sender,l.client_message_id)
    = (m.organization_id,m.channel_id,m.seq,'create',m.id,m.sender,m.client_message_id))),
  'badDigests',(SELECT count(*) FROM messages m WHERE octet_length(m.send_digest) IS DISTINCT FROM 32
    OR m.send_digest IS DISTINCT FROM public.fukulow_send_digest(m.channel_id,m.body,NULL,m.reply_to_id)
    OR m.send_digest IS DISTINCT FROM pg_catalog.sha256(pg_catalog.convert_to('fukulow.send.v1','UTF8')
    || pg_catalog.uuid_send(m.channel_id) || pg_catalog.decode('0000','hex') || pg_catalog.int4send(octet_length(m.body))
    || pg_catalog.convert_to(m.body,'UTF8'))));`;

export const shapeSQL = `SELECT json_build_object(
  'constraints',(SELECT json_agg(json_build_object('type',contype,'refs',confrelid::regclass::text) ORDER BY contype,confrelid::regclass::text)
    FROM pg_constraint WHERE conrelid='public.channel_log'::regclass AND contype IN ('p','f')),
  'inline',position('fukulow_send_digest' in (SELECT prosrc FROM pg_proc WHERE oid='public.fukulow_message_created()'::regprocedure))=0,
  'heap_bytes',pg_relation_size('public.channel_log'), 'index_bytes',pg_indexes_size('public.channel_log'));`;

type Counts = Record<string, number>;
export function fixtureReasons(fixture: Counts, counts: Counts, expected: number) {
  const reasons: string[] = [];
  if (fixture?.prefillMissing !== 0) reasons.push('prefill search-term coverage failed');
  if (fixture?.wrongTerms !== 0) reasons.push('post-window exact search terms differ');
  if (fixture?.unreadMismatches !== 0) reasons.push('message_counts_check failed');
  if (![fixture?.searchHeapBytes, fixture?.searchIndexBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
    reasons.push('search sizes missing or malformed');
  }
  if (!['messages', 'counterTotal', 'log'].every(key => counts?.[key] === expected)
    || !['badSequences', 'nonPlain', 'duplicateLog', 'orphanChannels', 'orphanSenders', 'missingCreates', 'badDigests']
      .every(key => counts?.[key] === 0)) reasons.push('C1/C2 Message integrity checks failed');
  return reasons;
}

export const maintenanceSQL = `WITH tables AS (
  SELECT oid, reloptions, true AS main FROM pg_class WHERE oid IN (${relationList})
  UNION ALL SELECT t.oid, t.reloptions, false FROM pg_class p JOIN pg_class t ON t.oid=p.reltoastrelid WHERE p.oid IN (${relationList})
) SELECT coalesce(json_agg(json_build_object('oid',t.oid::bigint,'name',t.oid::regclass::text,
  'disabled',coalesce(t.reloptions @> ARRAY['autovacuum_enabled=false'],false), 'main',t.main,
  'vacuum',s.autovacuum_count,'analyze',s.autoanalyze_count,'lastVacuum',s.last_autovacuum,'lastAnalyze',s.last_autoanalyze)
  ORDER BY t.oid),'[]') FROM tables t JOIN pg_stat_all_tables s ON s.relid=t.oid;`;

export const workersSQL = `SELECT json_build_object('wallMs',extract(epoch FROM clock_timestamp())*1000,
  'workers',(SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'autovacuum worker'),
  'vacuums',(SELECT count(*) FROM pg_stat_progress_vacuum));`;

export type Maintenance = { oid: number; name: string; main: boolean; disabled: boolean; vacuum: number; analyze: number;
  lastVacuum: string | null; lastAnalyze: string | null };
export type Workers = { wallMs: number; workers: number; vacuums: number };
export function maintenanceReasons(before: Maintenance[], after: Maintenance[], workers: Workers[], from: number, to: number) {
  const valid = (rows: Maintenance[]) => Array.isArray(rows) && new Set(rows.map(row => row.oid)).size === rows.length
    && relations.every(name => rows.some(row => row.main && (row.name === name || row.name === `public.${name}`)))
    && rows.every(row => Number.isSafeInteger(row.oid) && row.disabled === true && typeof row.main === 'boolean'
      && [row.vacuum, row.analyze].every(value => Number.isSafeInteger(value) && value >= 0)
      && [row.lastVacuum, row.lastAnalyze].every(value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value))));
  if (!valid(before) || !valid(after) || before.length !== after.length || !Array.isArray(workers) || workers.length < 2
    || workers.some(sample => !Number.isFinite(sample.wallMs) || sample.workers < 0 || sample.vacuums < 0
      || !Number.isSafeInteger(sample.workers) || !Number.isSafeInteger(sample.vacuums))
    || workers[0].wallMs > from || workers.at(-1)!.wallMs < to
    || workers.slice(1).some((row, index) => row.wallMs <= workers[index].wallMs)
    || before.some(row => !after.some(next => next.oid === row.oid))) return ['maintenance coverage or settings missing or malformed'];
  return JSON.stringify(before) !== JSON.stringify(after) || workers.some(sample => sample.workers || sample.vacuums)
    ? ['vacuum or analyze overlapped the window'] : [];
}
