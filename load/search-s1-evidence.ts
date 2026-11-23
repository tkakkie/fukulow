import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { repoPath, sha256 } from './search-m1-bodies.ts';
import type { Arm } from './search-m1-report.ts';
import { frozenPool, termsPerBody } from './search-s1-bodies.ts';

export const overlayPath = 'load/search-s1-overlay.sql';
export const s1ArmDirectory = (scenario: string, pair: number, arm: Arm) => `${scenario}-${pair}-${arm.toLowerCase()}`;
// PostgreSQL 18.6 deparse of 202611210725_message_search.sql with a fixed search_path.
export const originalTermsSha256 = 'd119c99973f6b3ac0420e3ac72e68dea85e3e64b9635fccda0890f2cb9646428';
export function overlaySource() {
  const text = readFileSync(repoPath(overlayPath), 'utf8');
  return { text, sha256: sha256(text) };
}

const readTermsFunction = `SET search_path = pg_catalog;
  SELECT json_build_object(
  'definition', pg_get_functiondef(oid), 'owner', pg_get_userbyid(proowner),
  'result', pg_get_function_result(oid), 'volatility', provolatile, 'strict', proisstrict, 'parallel', proparallel)
  FROM pg_proc WHERE oid = 'public.fukulow_search_terms(text)'::regprocedure`;

type TermsFunction = {
  definition: string; owner: string; result: string; volatility: string; strict: boolean; parallel: string;
};

export async function termsFunctionHash(sql: (query: string) => Promise<string>) {
  const fn = JSON.parse(await sql(readTermsFunction)) as TermsFunction;
  assert.match(fn.definition, /FUNCTION public\.fukulow_search_terms\(body text\)/);
  assert.equal(fn.owner, 'fukulow');
  assert.equal(fn.result, 'SETOF text');
  assert.equal(fn.volatility, 'i');
  assert.equal(fn.strict, true);
  assert.equal(fn.parallel, 's');
  return sha256(fn.definition);
}

const normalizePoolSql = (bodies: string[]) => `CREATE TEMP TABLE s1_bodies (body text);
COPY s1_bodies FROM STDIN;
${bodies.join('\n')}
\\.
SELECT count(*) FROM s1_bodies WHERE char_length(body) = 4000
  AND public.fukulow_search_normalize(body) COLLATE pg_catalog."C" = body COLLATE pg_catalog."C";
`;

export type S1Functions = {
  overlay: ReturnType<typeof overlaySource>; overlaidTermsSha256?: string;
};

export async function preflightS1(arm: Arm, functions: S1Functions, pool: ReturnType<typeof frozenPool>,
  sql: (query: string) => Promise<string>, sqlInput: (input: string) => Promise<string>) {
  const original = await termsFunctionHash(sql);
  assert.equal(original, originalTermsSha256, 'Search terms function differs from the pinned migration');
  if (arm === 'B') {
    assert.deepEqual(overlaySource(), functions.overlay, 'S1 overlay changed');
    await sql(functions.overlay.text);
    const overlaid = await termsFunctionHash(sql);
    assert.notEqual(overlaid, original, 'S1 overlay did not replace the function');
    assert.equal(await sql("SELECT count(*) FROM public.fukulow_search_terms('日本語')"), '0', 'S1 overlay returns terms');
    functions.overlaidTermsSha256 ??= overlaid;
    assert.equal(overlaid, functions.overlaidTermsSha256, 'Overlaid search terms function changed between arms');
  }
  const normalized = Number(await sqlInput(normalizePoolSql(pool.pool)));
  assert.equal(normalized, pool.count, 'S1 body pool changed under database normalization');
  return normalized;
}

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const acceptedPrefix = 'LOAD_S1_ACCEPTED ';
const organizationPrefix = 'LOAD_S1_ORGANIZATION ';
export function acceptedMessages(log: string, expected: number) {
  const lines = log.split('\n');
  const organizations = lines.filter(line => line.startsWith(organizationPrefix)).map(line => line.slice(organizationPrefix.length));
  assert.ok(organizations.length === 1 && uuidPattern.test(organizations[0]), 'Missing or invalid S1 Organization id');
  const ids = lines.filter(line => line.startsWith(acceptedPrefix)).map(line => line.slice(acceptedPrefix.length));
  assert.ok(ids.every(id => uuidPattern.test(id)), 'Malformed accepted client Message id');
  assert.equal(ids.length, expected, 'Accepted Message id count differs from k6');
  assert.equal(new Set(ids).size, ids.length, 'Duplicate accepted client Message id');
  return { organizationId: organizations[0], ids };
}

export const termCountsSql = ({ organizationId, ids }: ReturnType<typeof acceptedMessages>) =>
  `CREATE TEMP TABLE s1_accepted (client_message_id uuid PRIMARY KEY);
COPY s1_accepted FROM STDIN;
${ids.map(id => id + '\n').join('')}\\.
ANALYZE s1_accepted;
COPY (
  SELECT a.client_message_id, m.id,
    CASE WHEN m.id IS NOT NULL THEN (
      SELECT count(*) FROM public.message_search_terms t
      WHERE t.organization_id = m.organization_id AND t.message_id = m.id
    ) END AS terms
  FROM s1_accepted a
  LEFT JOIN public.messages m
    ON m.organization_id = '${organizationId}'::uuid AND m.client_message_id = a.client_message_id
  ORDER BY a.client_message_id
) TO STDOUT;
`;

export type TermCheck = { checked: number; expectedPerMessage: number; rowsPerMessage: Record<string, number> };

export function termCheck(ids: string[], raw: string, arm: Arm): TermCheck {
  const unchecked = new Set(ids);
  const rowsPerMessage: Record<string, number> = {};
  const rows = raw ? raw.split('\n') : [];
  for (const row of rows) {
    const [clientId, messageId, count, extra] = row.split('\t');
    assert.ok(unchecked.delete(clientId) && extra === undefined, 'Unexpected or duplicate Message term count');
    assert.ok(messageId === '\\N' && count === '\\N' ||
      uuidPattern.test(messageId) && /^\d+$/.test(count), 'Malformed Message term count');
    const key = count === '\\N' ? 'missing Message' : count;
    rowsPerMessage[key] = (rowsPerMessage[key] ?? 0) + 1;
  }
  assert.equal(unchecked.size, 0, 'Incomplete term-check rows');
  return { checked: rows.length, expectedPerMessage: arm === 'A' ? termsPerBody : 0, rowsPerMessage };
}

export function validTermCheck(check: TermCheck | undefined, accepted: number, arm: Arm) {
  const expected = arm === 'A' ? termsPerBody : 0;
  const rows = check?.rowsPerMessage;
  return check?.checked === accepted && check.expectedPerMessage === expected &&
    rows !== null && typeof rows === 'object' && !Array.isArray(rows) &&
    Object.keys(rows).length === Number(accepted > 0) &&
    (accepted === 0 || rows[String(expected)] === accepted);
}
