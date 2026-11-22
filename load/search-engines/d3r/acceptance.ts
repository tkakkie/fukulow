import assert from 'node:assert/strict';
import { criteria } from '../summarize.ts';
import { denialCases, probe } from '../definer.ts';
import { queries } from '../queries.ts';
import { channel, epoch, org, literal } from '../seed.ts';
import { hash } from '../manifest.ts';
import { allPages, explainPage, type Sql } from './engine.ts';
import { actors, begin, normalization, scopeContext, shortError, tokens } from './path.ts';

type Status = 'PASS' | 'FAIL' | 'NOT EVALUATED';

export const shortIds = ['ja1-frequent', 'ja1-rare', 'ascii1', 'ascii1-rare', 'scalar'];
export const accepts = (id: string) => !shortIds.includes(id);
const expectedRejection = (id: string, actor: number) =>
  actor === 6 ? 'organization_unavailable' : accepts(id) ? null : shortError;

function fixtureVisibility(c: number, actor: number) {
  if (actor === 3) return c < 8;
  if (actor === 4 || actor === 6) return false;
  return c % 2 === 0 || (actor === 1 && c < 20) || (actor === 2 && c % 5 === 0);
}

// Same normalization and per-token containment as load/d3r-semantics.ts.
// Read every non-deleted Message in the Organization without using the term
// table, then apply the frozen fixture's independently specified permissions.
async function reference(app: Sql) {
  await app(`${begin}\n${scopeContext(1)}\nSET LOCAL statement_timeout = 0;`);
  const prepared = [];
  for (const [id, raw] of queries) {
    const normalized: string = JSON.parse(await app(`SELECT to_json(normalized) FROM (${normalization(raw)}) q;`));
    prepared.push({ id, words: tokens(normalized), byChannel: new Map<string, {id: string; at: string}[]>() });
  }
  let after = '00000000-0000-0000-0000-000000000000';
  let scanned = 0;
  for (;;) {
    const batch = await app(`SELECT json_build_array(id, channel_id,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), public.fukulow_search_normalize(body))
      FROM public.messages
      WHERE organization_id = '${org(1)}' AND id > ${literal(after)}::uuid AND NOT deleted
      ORDER BY id LIMIT 5000;`);
    if (!batch) break;
    for (const row of batch.split('\n')) {
      const [id, channelId, at, body]: [string, string, string, string] = JSON.parse(row);
      for (const q of prepared) {
        if (!accepts(q.id) || !q.words.every(word => body.includes(word))) continue;
        let list = q.byChannel.get(channelId);
        if (!list) {
          list = [];
          q.byChannel.set(channelId, list);
        }
        list.push({id, at});
      }
      scanned++;
      after = id;
    }
  }
  await app('COMMIT;');
  assert.ok(scanned > 0, 'Completeness reference did not scan any Messages');
  return prepared;
}

const newestFirst = (a: {id: string; at: string}, b: {id: string; at: string}) =>
  a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a.at < b.at ? 1 : -1);

export async function completeness(app: Sql) {
  const expected = await reference(app);
  const cutoff = epoch - 180 * 86400000;
  const report = [];
  for (const [i, [id, raw]] of queries.entries()) {
    const checked = [];
    for (const actor of actors) {
      const wanted = Array.from({length: 40}, (_, c) => c).filter(c => fixtureVisibility(c, actor))
        .flatMap(c => expected[i].byChannel.get(channel(1, c)) ?? []).sort(newestFirst);
      const found = await allPages(app, [1, actor], raw);
      const rejection = expectedRejection(id, actor);
      const actualHash = hash(found.ids.join('\n'));
      const expectedHash = hash(wanted.map(row => row.id).join('\n'));
      checked.push({actor, actualRows: found.ids.length, expectedRows: wanted.length,
        expectedOlderThan180Days: wanted.filter(row => Date.parse(row.at) < cutoff).length, actualHash, expectedHash,
        rejection: found.rejection, expectedRejection: rejection,
        paginationError: found.paginationError, equal: !found.paginationError && actualHash === expectedHash && found.rejection === rejection});
    }
    report.push({query: id, actors: checked});
  }
  return report;
}

export async function denials(app: Sql) {
  const checks = [];
  for (const c of denialCases) {
    // Probe 4 is still in the fixture and becomes visible under full history.
    const expected = [...c.expect];
    if (c.query === 'denialprobe' && expected.includes(1)) expected.push(4);
    const wanted = expected.map(probe).sort();
    for (const forced of [false, true]) {
      const result = await allPages(app, c.actor, c.query, {context: c.context, forced});
      const found = result.ids.sort();
      const expectedRejection = c.query === '' ? shortError
        : c.context !== c.actor[0] || c.actor[1] === 6 ? 'organization_unavailable' : null;
      checks.push({case: c.name, forced, found, expected: wanted, rejection: result.rejection, expectedRejection,
        paginationError: result.paginationError,
        equal: !result.paginationError && JSON.stringify(found) === JSON.stringify(wanted) && result.rejection === expectedRejection});
    }
  }
  const plan = await explainPage(app, 'denialprobe', [1, 1], true);
  return {checks, plan};
}

type Report = Awaited<ReturnType<typeof completeness>>;
type Denials = Awaited<ReturnType<typeof denials>>;
type Plan = Pick<Awaited<ReturnType<typeof explainPage>>, 'searchIndex' | 'seqScanMessages'>;
type Latency = {n: number; p50: number; p95: number; p99: number};
export type Round = {round: number; latencies: {query: string; n: number; p50: number; p95: number; p99: number}[]};
export type Evidence = {
  valid: boolean; formal: boolean; backfill: boolean;
  rounds: Round[];
  plans: (Plan & {query: string})[];
  complete: Report;
  denials: Denials;
  restore: {checksumEqual: boolean; termsEqual: boolean; complete: Report};
};

function reportStatus(report: Report): Status {
  if (report.length !== queries.length || report.some(({query, actors: rows}, i) => query !== queries[i][0] ||
    !Array.isArray(rows) || rows.length !== actors.length ||
    rows.some((row, j) => row.actor !== actors[j] || typeof row.equal !== 'boolean' ||
      row.expectedRejection !== expectedRejection(query, row.actor) || !validRejection(row.rejection) ||
      ![row.actualRows, row.expectedRows, row.expectedOlderThan180Days].every(n => Number.isSafeInteger(n) && n >= 0) ||
      row.expectedOlderThan180Days > row.expectedRows || !isHash(row.actualHash) || !isHash(row.expectedHash)))) return 'NOT EVALUATED';
  return report.every(q => q.actors.every(actor => actor.equal && actor.actualRows === actor.expectedRows &&
    actor.actualHash === actor.expectedHash && actor.rejection === actor.expectedRejection && !actor.paginationError)) ? 'PASS' : 'FAIL';
}

const isHash = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validRejection = (value: string | null) => value === null || typeof value === 'string';

export function judge(e: Partial<Evidence>): Status {
  if (e.valid !== true || e.formal !== true || e.backfill !== true || !Array.isArray(e.rounds) || !Array.isArray(e.plans) ||
    !Array.isArray(e.complete) || !e.restore || !Array.isArray(e.restore.complete) ||
    !e.denials || !Array.isArray(e.denials.checks) || !e.denials.plan) return 'NOT EVALUATED';
  const ids = queries.map(([id]) => id);
  const accepted = ids.filter(accepts);
  if (e.rounds.length !== 3 || e.rounds.some((round, index) => round.round !== index + 1 ||
    round.latencies.length !== ids.length || round.latencies.some((l, i) => l.query !== ids[i] || !latencyValid(l)))) return 'NOT EVALUATED';
  if (e.plans.length !== accepted.length || e.plans.some((plan, i) => plan.query !== accepted[i] ||
    typeof plan.searchIndex !== 'boolean' || typeof plan.seqScanMessages !== 'boolean')) return 'NOT EVALUATED';
  const complete = reportStatus(e.complete);
  const restored = reportStatus(e.restore.complete);
  if (complete === 'NOT EVALUATED' || restored === 'NOT EVALUATED' ||
    !e.complete.some(q => q.actors.some(actor => actor.expectedOlderThan180Days > 0)) ||
    typeof e.restore.checksumEqual !== 'boolean' || typeof e.restore.termsEqual !== 'boolean' ||
    typeof e.denials.plan.searchIndex !== 'boolean' ||
    e.denials.checks.length !== denialCases.length * 2 || e.denials.checks.some((c, i) =>
      c.case !== denialCases[Math.floor(i / 2)].name || c.forced !== Boolean(i % 2) ||
      typeof c.equal !== 'boolean' || !Array.isArray(c.found) || !Array.isArray(c.expected) ||
      !validRejection(c.rejection) || !validRejection(c.expectedRejection))) return 'NOT EVALUATED';
  return e.rounds.some(r => r.latencies.some(l => accepts(l.query) && l.p95 > criteria.p95LimitMs)) ||
    e.plans.some(p => p.seqScanMessages || !p.searchIndex) || complete === 'FAIL' || restored === 'FAIL' ||
    !e.restore.checksumEqual || !e.restore.termsEqual ||
    e.denials.checks.some(c => !c.equal || c.rejection !== c.expectedRejection || c.paginationError ||
      JSON.stringify(c.found) !== JSON.stringify(c.expected)) || !e.denials.plan.searchIndex ? 'FAIL' : 'PASS';
}

function latencyValid(l: Latency) {
  return l.n === criteria.samplesPerQueryRound &&
    [l.p50, l.p95, l.p99].every(n => Number.isFinite(n) && n >= 0) && l.p50 <= l.p95 && l.p95 <= l.p99;
}
