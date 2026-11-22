import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { literal, org } from '../seed.ts';
import { scopeContext } from './path.ts';
import type { Sql } from './engine.ts';

const batchSize = 5_000;
const initialID = '00000000-0000-0000-0000-000000000000';
const fromScope = (o: number, after: string) =>
  `organization_id = '${org(o)}' AND id > ${literal(after)}::uuid`;

export function expectedTerms(normalized: string) {
  const chars = [...normalized];
  const grams = new Map<string, Buffer>();
  for (let i = 0; i < chars.length - 1; i++) {
    const pair = chars[i] + chars[i + 1];
    if (!grams.has(pair)) grams.set(pair, Buffer.from(pair));
    if (i + 2 < chars.length) {
      const triple = pair + chars[i + 2];
      if (!grams.has(triple)) grams.set(triple, Buffer.from(triple));
    }
  }
  const h = createHash('sha256');
  for (const [value, bytes] of [...grams].sort((a, b) => a[1].compare(b[1]))) {
    h.update(String([...value].length)).update(bytes);
  }
  return { count: grams.size, sha256: h.digest('hex') };
}

// Read the production write statement and provide a bounded, Organization-local
// selection of Message IDs to its array argument.
export function insertSql(engine: string, o: number, after: string) {
  const statement = engine.match(/"(INSERT INTO message_search_terms [^"]+)"/)?.[1];
  assert.ok(statement && statement.includes('m.id=ANY($2)'), 'Production term insertion changed');
  return `WITH batch AS MATERIALIZED (
    SELECT id FROM public.messages WHERE ${fromScope(o, after)} ORDER BY id LIMIT ${batchSize}
  ), inserted AS (
    ${statement.replace('$1', `'${org(o)}'`).replace('$2', 'ARRAY(SELECT id FROM batch)')}
    RETURNING 1
  )
  SELECT json_build_array((SELECT max(id::text) FROM batch), (SELECT count(*) FROM inserted));`;
}

const rowCounts = `SELECT json_build_object(
  'termRows', (SELECT count(*) FROM public.message_search_terms),
  'tableBytes', pg_table_size('public.message_search_terms'),
  'indexes', (SELECT json_object_agg(indexrelid::regclass::text, pg_relation_size(indexrelid))
    FROM pg_index WHERE indrelid = 'public.message_search_terms'::regclass)
);`;

function checkSql(o: number, after: string) {
  return `WITH batch AS MATERIALIZED (
    SELECT id, channel_id, created_at, body, deleted FROM public.messages
    WHERE ${fromScope(o, after)} ORDER BY id LIMIT ${batchSize}
  ), actual AS (
    SELECT t.message_id, count(*) AS rows,
      encode(sha256(convert_to(string_agg(length(t.term)::text || t.term, '' ORDER BY t.term), 'UTF8')), 'hex') AS digest,
      bool_and(t.created_at = m.created_at AND t.channel_id = m.channel_id) AS keys_match
    FROM batch m JOIN public.message_search_terms t ON t.organization_id = '${org(o)}' AND t.message_id = m.id
    GROUP BY t.message_id
  )
  SELECT json_build_array(m.id, CASE WHEN m.deleted THEN '' ELSE public.fukulow_search_normalize(m.body) END,
    coalesce(a.rows, 0), a.digest, coalesce(a.keys_match, true))
  FROM batch m LEFT JOIN actual a ON a.message_id = m.id ORDER BY m.id;`;
}

export async function verifyTerms(sql: Sql, expectedRows: number, termRows: number) {
  let checked = 0;
  let sum = 0;
  let mismatches = 0;
  for (const o of [1, 2, 3]) {
    let after = initialID;
    for (;;) {
      const text = await sql(checkSql(o, after));
      if (!text) break;
      for (const line of text.split('\n')) {
        const [id, normalized, count, digest, keys]: [string, string, number, string | null, boolean] = JSON.parse(line);
        const expected = expectedTerms(normalized);
        if (!keys || count !== expected.count || digest !== (expected.count ? expected.sha256 : null)) mismatches++;
        checked++;
        sum += expected.count;
        after = id;
      }
    }
  }
  return { checked, expectedTermRows: sum, mismatches,
    equal: checked === expectedRows && sum === termRows && mismatches === 0 };
}

export async function backfill(owner: Sql, app: Sql, engine: string, expectedRows: number) {
  const oldLsn = await owner('SELECT pg_current_wal_insert_lsn();');
  const start = performance.now();
  let inserted = 0;
  for (const o of [1, 2, 3]) {
    let after = initialID;
    for (;;) {
      const output = await app(`BEGIN;
${scopeContext(o)}
SET LOCAL statement_timeout = 0;
${insertSql(engine, o, after)}
COMMIT;`);
      const [last, rows]: [string | null, number] = JSON.parse(output.split('\n').at(-1)!);
      inserted += rows;
      if (!last) break;
      after = last;
    }
  }
  const durationMs = performance.now() - start;
  const walBytes = Number(await owner(`SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), ${literal(oldLsn)});`));
  const stats: {termRows: number; tableBytes: number; indexes: Record<string, number>} = JSON.parse(await owner(rowCounts));
  const verifyStart = performance.now();
  const verification = await verifyTerms(owner, expectedRows, stats.termRows);
  return { durationMs, walBytes, inserted, ...stats,
    verification: {...verification, durationMs: performance.now() - verifyStart, equal: verification.equal && inserted === stats.termRows} };
}
