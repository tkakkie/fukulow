import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { definerColumns, definerConfig, denialCases } from './definer.ts';
import { queryPath } from './manifest.ts';
import { search } from './queries.ts';

const sql = readFileSync(new URL('./definer.sql',import.meta.url),'utf8');
const code = sql.split('\n').filter(line=>!line.trimStart().startsWith('--')).join('\n');

const header = code.slice(code.indexOf('CREATE OR REPLACE FUNCTION'),code.indexOf('BEGIN ATOMIC'));
test('function settings are exactly the query-path ones recorded in the manifest',()=>{
  const settings = Object.fromEntries([...header.matchAll(/^SET (\w+) = (.+)$/gm)].map(m=>[m[1],m[2]]));
  assert.deepEqual(settings,queryPath.functionSettings);
  // proconfig as verified at runtime: nothing that changes v1 planner/executor conditions (no jit).
  assert.equal(definerConfig,Object.entries(settings).map(([k,v])=>`${k}=${v}`).join(';'));
  assert.doesNotMatch(header,/\bjit\b|enable_|work_mem|cost/);
  assert.match(code,/^SET search_path = pg_catalog, public;\nCREATE OR REPLACE FUNCTION/m);
  assert.match(code,/LANGUAGE sql STABLE STRICT SECURITY DEFINER\n/);
  assert.match(code,/\nBEGIN ATOMIC\n/);
});
test('Organization comes only from the context and filters every table',()=>{
  assert.match(code,/fukulow_search_messages\(actor uuid, query text, page boolean\)/);
  for (const alias of ['c','u','cm','m']) assert.match(code,new RegExp(`\\b${alias}\\.organization_id = public\\.fukulow_current_org\\(\\)`));
  assert.doesNotMatch(code,/\b(FROM|JOIN) (?!public\.)(messages|channels|users|channel_members)\b/);
});
test('range, clock and page match the direct query',()=>{
  const direct = search('x');
  for (const part of ["TIMESTAMPTZ '2026-11-15 00:00:00+00' - INTERVAL '180 days'","<= TIMESTAMPTZ '2026-11-15 00:00:00+00'",'LIMIT 20'])
    assert.ok(direct.includes(part),part);
  assert.match(code,/TIMESTAMPTZ '2026-11-15 00:00:00\+00' - INTERVAL '180 days'/);
  assert.match(code,/LIMIT CASE WHEN \$3 THEN 20 END/);
  assert.match(code,/replace\(replace\(replace\(\$2, '\\', '\\\\'\), '%', '\\%'\), '_', '\\_'\)/);
});
test('EXECUTE is revoked from PUBLIC and granted only to the app role',()=>{
  assert.deepEqual([...code.matchAll(/^(GRANT|REVOKE) .*ON FUNCTION .*$/gm)].map(m=>m[0].replace(/ ON FUNCTION .*? (TO|FROM) /,' -> ')),
    ['REVOKE ALL -> PUBLIC;','GRANT EXECUTE -> fukulow_app;']);
});
test('column grants equal the columns the verifier expects',()=>{
  const granted = [...code.matchAll(/^GRANT SELECT \(([^)]+)\) ON public\.(\w+) TO fukulow_search;$/gm)]
    .flatMap(m=>m[1]!.split(', ').map(c=>`${m[2]}.${c}:SELECT`)).sort().join(',');
  assert.equal(granted,definerColumns);
});
test('denials cover each rule with a positive control',()=>{
  const names = denialCases.map(c=>c.name).join('\n');
  for (const rule of [/other Organization/,/private Channel non-member/,/non-member Owner/,/non-member Admin/,/DM non-participant/,/revoked after the Message was sent/,/demoted to Guest loses public access/,/DM non-participant Owner/,/DM non-participant Member/,/stale grant/,/guest without grant/,/deactivated/,/NULL Organization/,/trailing backslash/,/empty query/])
    assert.match(names,rule);
  assert.ok(denialCases.filter(c=>c.expect.length).length>=4);
});
