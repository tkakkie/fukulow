import { hasStatementFields, topLevel, type Statement } from './validity.ts';
import type { Arm } from './c3-plan.ts';

export const statementSQL = `SELECT coalesce(json_agg(s ORDER BY s.toplevel DESC, s.queryid), '[]') FROM (
  SELECT toplevel, queryid::text, calls, total_exec_time, wal_records, wal_bytes, wal_fpi, query
  FROM pg_stat_statements JOIN pg_roles ON userid=pg_roles.oid
  WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND rolname='fukulow_app') s;`;

export function evictionReason(before: number, after: number) {
  if (!Number.isSafeInteger(before) || before < 0 || after !== before) return 'statement eviction counter changed or unavailable';
}

const normalize = (query: string) => query.trim().replace(/\s+/g, ' ').toLowerCase();
const insert = (relation: string) => `insert into (?:public\\.)?${relation}\\b`;
const message = insert('messages'), create = insert('channel_log'), search = insert('message_search_terms');
const signatures = [
  ['message', new RegExp(`^${message}.*on conflict.*do nothing returning`) ],
  ['create', new RegExp(`^${create}.*event_seq.*kind.*message_id.*client_message_id.*values`) ],
  ['fused', new RegExp(`^with .*${message}.*on conflict.*do nothing returning.*${create}.*event_seq.*kind.*message_id.*client_message_id.*select`) ],
  ['search', new RegExp(`^${search}.*fukulow_search_terms\\(.*not m\\.deleted`) ],
] as const;

export function statementEvidence(rows: Statement[], accepted: number) {
  if (!hasStatementFields(rows) || !topLevel(rows).length || !Number.isSafeInteger(accepted) || accepted < 1
    || rows.some(row => !Number.isSafeInteger(row.calls) || row.calls <= 0 || row.total_exec_time < 0)) {
    throw new Error('statement evidence missing or malformed');
  }
  const entries = rows.filter(row => row.query.trim() !== 'SELECT 1').map(row => {
    const query = normalize(row.query);
    const family = row.toplevel ? signatures.find(([, pattern]) => pattern.test(query))?.[0] ?? 'other' : 'other';
    return [JSON.stringify([row.toplevel, String(row.queryid), query]), { family, callsPerSend: row.calls / accepted }] as const;
  });
  const signaturesByQuery = Object.fromEntries(entries);
  if (Object.keys(signaturesByQuery).length !== entries.length) throw new Error('duplicate statement signature');
  const families = Object.values(signaturesByQuery);
  const core = Object.fromEntries(signatures.map(([name]) => [name,
    families.filter(row => row.family === name).reduce((sum, row) => sum + row.callsPerSend, 0)]));
  const top = topLevel(rows);
  return { signaturesByQuery, core, executorUsec: top.reduce((sum, row) => sum + row.total_exec_time, 0) * 1000 / accepted,
    total: top.reduce((sum, row) => sum + row.calls, 0) / accepted };
}

type Evidence = ReturnType<typeof statementEvidence>;
const near = (actual: number, expected: number) => Math.abs(actual - expected) <= 0.05 + Number.EPSILON * 16;

export function statementReasons(arm: Arm, actual: Evidence, base?: Evidence) {
  const why: string[] = [];
  const expected = arm === 'c3' ? { message: 0, create: 0, fused: 1, search: 1 } : { message: 1, create: 1, fused: 0, search: 1 };
  for (const [family, calls] of Object.entries(expected)) {
    if (actual.core[family] !== calls) why.push(`${family} statement calls per send differ from ${calls}`);
  }
  if (arm === 'base') return why;
  if (!base) return [...why, 'same-shape, same-round base is missing or INVALID'];
  const comparable = (evidence: Evidence) => Object.fromEntries(Object.entries(evidence.signaturesByQuery)
    .filter(([, row]) => ['other', 'search'].includes(row.family)).map(([key, row]) => [key, row.callsPerSend]));
  const reference = comparable(base), candidate = comparable(actual);
  for (const key of new Set([...Object.keys(reference), ...Object.keys(candidate)])) {
    if (!near(candidate[key] ?? 0, reference[key] ?? 0)) why.push(`statement signature changed against base: ${key}`);
  }
  if (!near(actual.total, base.total - Number(arm === 'c3'))) why.push('total SQL calls per send differ from expected delta against base');
  return why;
}
