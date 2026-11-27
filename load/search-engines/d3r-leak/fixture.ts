import assert from 'node:assert/strict';
import { insertSql, termsMatch, verifyTerms } from '../d3r/backfill.ts';
import { scopeContext } from '../d3r/path.ts';
import { channel, literal, org, uuid } from '../seed.ts';
import { directRls, directRlsExpected, verifyRls } from '../d3r/rls.ts';
import { appSessionSettings } from '../manifest.ts';
import { backgroundSql, finishSequencesSql, foreignMessageCount, hit, slotIds, slotScope, slotsSql, visible, type ArmFixture } from './arms.ts';
import { queries, type Design } from './design.ts';

export type SyncSql = (text: string) => string;
export type Database = {owner: SyncSql; app: SyncSql};

function fillTerms(app: SyncSql, engine: string, from: ReadonlyArray<readonly [number, string]>) {
  for (const [o, cursor] of from) {
    let after = cursor;
    for (;;) {
      const result = app(`BEGIN;
${scopeContext(o)}
SET LOCAL statement_timeout = 0;
${insertSql(engine, o, after)}
COMMIT;`);
      const [last]: [string | null, number] = JSON.parse(result.split('\n').at(-1)!);
      if (!last) break;
      after = last;
    }
  }
}

export async function seedArm({owner, app}: Database, engine: string, arm: ArmFixture, design: Design) {
  owner(backgroundSql(arm, design));
  if (!arm.afterVacuum) owner(slotsSql(arm, design));
  owner(finishSequencesSql());
  fillTerms(app, engine, [[1, uuid(0)], [2, uuid(0)]]);
  owner('VACUUM ANALYZE;');
  if (arm.afterVacuum) {
    owner(slotsSql(arm, design));
    owner(finishSequencesSql());
    // The production INSERT never replaces existing terms. Only index the new IDs.
    const {o} = slotScope(arm);
    fillTerms(app, engine, [[o, uuid(3_000_000)]]);
  }
  const messages = design.messages + (arm.extraForeignMessages ?? 0);
  const termRows = Number(owner('SELECT count(*) FROM public.message_search_terms;'));
  const termEvidence = await verifyTerms(async text => owner(text), messages, termRows);
  assert.ok(termsMatch(termEvidence, messages, termRows), 'Term backfill disagrees with Message terms');
  return {vacuumAnalyze: true, slotsInsertedAfterVacuum: Boolean(arm.afterVacuum), termEvidence, termRows};
}

export function rlsAssertions(app: SyncSql) {
  const role = verifyRls(app, appSessionSettings);
  const direct = directRls(app);
  assert.equal(direct, directRlsExpected, 'Transaction-local Organization RLS assertion failed');
  return {role, direct};
}

export function readFixture(owner: SyncSql, arm: ArmFixture, design: Design) {
  const query = queries[arm.query], probe = query.slice(0, 3);
  const scopeList = visible.map(literal).join(', ');
  const see = `organization_id = '${org(1)}' AND channel_id IN (${scopeList})`;
  const visibleRows = `(${see})`;
  const slots = slotIds('id', arm);
  const extra = `id BETWEEN '${uuid(4_000_001)}' AND '${uuid(4_000_000 + (arm.extraForeignMessages ?? 0))}'`;
  const {o, c} = slotScope(arm);
  const inScope = `organization_id = '${org(o)}' AND channel_id = '${channel(o, c)}'`;
  const data = JSON.parse(owner(`
    WITH normalized AS MATERIALIZED (
      SELECT m.*, strpos(public.fukulow_search_normalize(body) COLLATE pg_catalog."C", '${query}') > 0 AS matched,
        to_jsonb(m) AS message_json FROM public.messages m
    ), terms AS (
      SELECT count(*) FILTER (WHERE organization_id = '${org(2)}') AS other_org_rows,
        count(*) FILTER (WHERE term = '${probe}' AND NOT ${visibleRows}) AS foreign_probe_rows
      FROM public.message_search_terms
    )
    SELECT json_build_object(
      'messages', count(*),
      'fingerprint', encode(sha256(convert_to(string_agg(
        CASE WHEN ${slots} THEN ((message_json - 'body' - 'send_digest') || jsonb_build_object('bodyBytes', octet_length(body)))::text
          ELSE message_json::text END, E'\\n' ORDER BY id) FILTER (WHERE NOT (${extra})), 'UTF8')), 'hex'),
      'wholeBodyFingerprint', encode(sha256(convert_to(string_agg(message_json::text, E'\\n' ORDER BY id), 'UTF8')), 'hex'),
      'visibleMatches', count(*) FILTER (WHERE matched AND ${visibleRows}),
      'foreignMatches', count(*) FILTER (WHERE matched AND NOT ${visibleRows}),
      'targetMatches', count(*) FILTER (WHERE matched AND ${inScope} AND ${slots}),
      'visibleCandidates', count(*) FILTER (WHERE ${visibleRows} AND NOT matched AND id <> '${hit}'
        AND created_at > (SELECT created_at FROM public.messages WHERE id = '${hit}')
        AND '${probe}' IN (SELECT public.fukulow_search_terms(body))),
      'foreignProbeRows', (SELECT foreign_probe_rows FROM terms),
      'otherOrgTermRows', (SELECT other_org_rows FROM terms))
    FROM normalized;`)) as {
      messages: number; fingerprint: string; wholeBodyFingerprint: string; visibleMatches: number; foreignMatches: number;
      targetMatches: number; visibleCandidates: number; foreignProbeRows: number; otherOrgTermRows: number;
    };
  assert.equal(data.messages, design.messages + (arm.extraForeignMessages ?? 0));
  assert.equal(data.visibleMatches, 1);
  assert.equal(data.foreignMatches, arm.matches);
  assert.equal(data.targetMatches, arm.matches);
  assert.equal(data.foreignProbeRows, arm.matches);
  assert.equal(data.visibleCandidates, arm.candidates);
  assert.equal(data.otherOrgTermRows, 5 * (foreignMessageCount(arm, design) + (arm.extraForeignMessages ?? 0)));
  assert.match(data.fingerprint, /^[a-f0-9]{64}$/);
  return data;
}
