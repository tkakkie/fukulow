// Settled-fixture SQL (the #160 diagnose shape). Pure builders: the runner pipes
// them to psql as the owner role inside the disposable stack.
import { createLog } from '../channel-log.ts';
import { fixture, insertAutovacuumOff, type Arm } from './config.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const checked = (ids: string[]) => { if (!ids.every(id => uuid.test(id))) throw new Error('fixture id is not a UUID'); return ids; };
const array = (ids: string[]) => `ARRAY[${checked(ids).map(id => `'${id}'`).join(',')}]::uuid[]`;

// counts[i] Messages of 17 B go to channels[i]; ids, client ids and senders are deterministic.
export function prefillSQL(organization: string, channels: string[], counts: number[]): string {
  if (channels.length !== counts.length || counts.some(n => !Number.isInteger(n) || n < 0)) throw new Error('bad prefill plan');
  checked([organization]);
  return `BEGIN;
CREATE TEMP TABLE slice5_members ON COMMIT DROP AS
  SELECT substring(a.email FROM '^member-(\\d+)@')::int AS idx, u.id FROM users u JOIN accounts a ON a.id = u.account_id
  WHERE u.organization_id = '${organization}' AND a.email LIKE 'member-%';
DO $$ BEGIN IF (SELECT count(*) FROM slice5_members) <> ${fixture.members} THEN RAISE EXCEPTION 'member fixture'; END IF; END $$;
CREATE TEMP TABLE slice5_plan ON COMMIT DROP AS
  SELECT ord::int - 1 AS c, id, n FROM unnest(${array(channels)}, ARRAY[${counts.join(',')}]::int[]) WITH ORDINALITY AS t(id, n, ord);
INSERT INTO messages (organization_id, id, channel_id, seq, sender, client_message_id, body)
  SELECT '${organization}', md5('slice5/m/' || p.c || '/' || s)::uuid, p.id, s, m.id, md5('slice5/c/' || p.c || '/' || s)::uuid, '${fixture.shortBody}'
  FROM slice5_plan p CROSS JOIN LATERAL generate_series(1, p.n) s JOIN slice5_members m ON m.idx = (p.c * ${fixture.perChannel} + s) % ${fixture.members};
INSERT INTO channel_message_sequences (organization_id, channel_id, seq)
  SELECT '${organization}', id, n FROM slice5_plan WHERE n > 0
  ON CONFLICT (organization_id, channel_id) DO UPDATE SET seq = EXCLUDED.seq;
COMMIT;`;
}

// A (and only A) has channel_log; its Create rows come from the shared load fixture statement.
export function channelLogSQL(arm: Arm, org: string, channels: string[]): string {
  const presence = `DO $$ BEGIN IF (to_regclass('public.channel_log') IS NOT NULL) <> ${arm === 'A'} THEN RAISE EXCEPTION 'channel_log presence does not match the arm'; END IF; END $$;`;
  checked([org, ...channels]);
  return arm === 'B' ? presence : `${presence}\n${createLog(org, channels)}`;
}

// Q2 control condition: insert-triggered autovacuum off on the Message tables and their TOAST, in both arms.
export const autovacuumSQL = insertAutovacuumOff.map(t => `DO $$ BEGIN IF to_regclass('public.${t}') IS NOT NULL THEN
  ALTER TABLE public.${t} SET (autovacuum_vacuum_insert_threshold = -1, toast.autovacuum_vacuum_insert_threshold = -1); END IF; END $$;`).join('\n');

export const settleSQL = 'VACUUM (FREEZE, ANALYZE);\nCHECKPOINT;';

// Logical checksum, taken right after the prefill: identical in both arms for an identical
// prefill (random row ids, arm-specific columns and Channel/Member UUIDs excluded).
export const checksumSQL = `SELECT md5(string_agg(row, ',' ORDER BY row)) FROM (
  SELECT concat_ws(':', ch.name, count(*), min(m.seq), max(m.seq), sum(octet_length(m.body)),
    md5(string_agg(m.client_message_id::text || '/' || a.email, '' ORDER BY m.seq))) AS row
  FROM messages m JOIN channels ch ON ch.organization_id = m.organization_id AND ch.id = m.channel_id
  JOIN users u ON u.organization_id = m.organization_id AND u.id = m.sender JOIN accounts a ON a.id = u.account_id
  GROUP BY ch.name) x`;

export const relationBytesSQL = `SELECT COALESCE(sum(pg_total_relation_size(relid)), 0)::bigint FROM pg_stat_user_tables`;

// Relations whose autovacuum or autoanalyze inside a step invalidates its WAL: the Message tables, their TOAST and both sets of indexes.
export const watchedRelationsSQL = `WITH tables AS (
  SELECT c.oid, c.reltoastrelid FROM pg_class c
  WHERE c.oid IN (SELECT to_regclass('public.' || t) FROM unnest(ARRAY[${insertAutovacuumOff.map(t => `'${t}'`).join(',')}]) t)
), heaps AS (SELECT oid FROM tables UNION SELECT reltoastrelid FROM tables WHERE reltoastrelid <> 0),
watched AS (SELECT oid FROM heaps UNION SELECT indexrelid FROM pg_index WHERE indrelid IN (SELECT oid FROM heaps))
SELECT COALESCE(json_agg(oid::bigint), '[]') FROM watched`;

// What the server actually applied: the Q2 settings and the watched tables' reloptions (arm-independent shape).
export const appliedSettingsSQL = `SELECT json_build_object(
  'settings',(SELECT json_object_agg(name, setting ORDER BY name) FROM pg_settings WHERE name IN ('max_wal_size','checkpoint_timeout','autovacuum','shared_buffers','synchronous_commit','autovacuum_vacuum_insert_threshold')),
  'messages',(SELECT reloptions FROM pg_class WHERE oid = 'public.messages'::regclass),
  'messagesToast',(SELECT t.reloptions FROM pg_class c JOIN pg_class t ON t.oid = c.reltoastrelid WHERE c.oid = 'public.messages'::regclass),
  'channelLogMatches',(SELECT to_regclass('public.channel_log') IS NULL OR (SELECT reloptions FROM pg_class WHERE oid = to_regclass('public.channel_log')) = (SELECT reloptions FROM pg_class WHERE oid = 'public.messages'::regclass)))`;
