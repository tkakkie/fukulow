import assert from 'node:assert/strict';
import { criteria } from '../summarize.ts';
import { denialCases, probe } from '../definer.ts';
import { queries } from '../queries.ts';
import { channel, epoch, org, literal } from '../seed.ts';
import { hash } from '../manifest.ts';
import { termEvidence, termsMatch, verifiedBackfill, type BackfillRecord, type verifyTerms } from './backfill.ts';
import { directRlsExpected, directRlsRecorded, validRls, type verifyRls } from './rls.ts';
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

export function denialExpectation(c: typeof denialCases[number]) {
  // Probe 4 becomes visible under full history.
  const expected = c.query === 'denialprobe' && c.expect.includes(1) ? [...c.expect, 4] : c.expect;
  const expectedRejection = c.query === '' ? shortError
    : c.context !== c.actor[0] || c.actor[1] === 6 ? 'organization_unavailable' : null;
  return {expected: expected.map(probe).sort(), expectedRejection};
}

export async function denials(app: Sql) {
  const checks = [];
  for (const c of denialCases) {
    const {expected: wanted, expectedRejection} = denialExpectation(c);
    for (const forced of [false, true]) {
      const result = await allPages(app, c.actor, c.query, {context: c.context, forced});
      const found = result.ids.sort();
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
export type Sample = {query: string} & (Latency & {outcomes?: string[]} | {outcomes: string[]; sqlError: string});
export type Round = {round: number; latencies: Sample[]};
type RlsRecord = ReturnType<typeof verifyRls>;
export type Evidence = {
  valid: boolean; formal: boolean; backfill: BackfillRecord;
  rounds: Round[];
  plans: (Plan & {query: string})[];
  complete: Report;
  denials: Denials & {measuredRls: string};
  restore: {
    before: string; after: string; restoreMs: number; termRows: number; expectedTermRows: number;
    terms: Awaited<ReturnType<typeof verifyTerms>>;
    rls: {settings: RlsRecord; cleanup: string};
    complete: Report;
  };
};

function reportStatus(report: Report): Status {
  if (report.length !== queries.length || report.some(({query, actors: rows}, i) => query !== queries[i][0] ||
    !Array.isArray(rows) || rows.length !== actors.length || !dense(rows) ||
    rows.some((row, j) => row.actor !== actors[j] || typeof row.equal !== 'boolean' ||
      row.expectedRejection !== expectedRejection(query, row.actor) || !validRejection(row.rejection) ||
      ![row.actualRows, row.expectedRows, row.expectedOlderThan180Days].every(n => Number.isSafeInteger(n) && n >= 0) ||
      row.expectedOlderThan180Days > row.expectedRows || !isHash(row.actualHash) || !isHash(row.expectedHash)))) return 'NOT EVALUATED';
  return report.every(q => q.actors.every(actor => actor.equal && actor.actualRows === actor.expectedRows &&
    actor.actualHash === actor.expectedHash && actor.rejection === actor.expectedRejection && !actor.paginationError)) ? 'PASS' : 'FAIL';
}

const isHash = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validRejection = (value: string | null) => value === null || typeof value === 'string';

// The formal judge classifies some aborted checks (a short-query SQL error, a pagination error) as FAIL,
// not NOT EVALUATED. A rehearsal therefore requires its evidence to be whole instead of listing known
// failure kinds: every array dense, no missing item, no recorded error, every query fully sampled.
export const fullySampled = (l?: Sample) => l !== undefined && l !== null && !('sqlError' in l) && 'n' in l &&
  l.n === criteria.samplesPerQueryRound && (accepts(l.query) || l.outcomes?.length === criteria.samplesPerQueryRound);

export const dense = (list: unknown[]) => Array.from({length: list.length}, (_, i) => i).every(i => i in list &&
  list[i] !== undefined && list[i] !== null);

function whole(value: unknown): boolean {
  if (Array.isArray(value)) return dense(value) && value.every(whole);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(([key, item]) => (!/error$/i.test(key) || item === undefined || item === null) && whole(item));
}

// A rehearsal has one formal-size round. Its evidence is complete when it is whole and the formal checks
// would accept it with that round in every slot. Only this boolean leaves the function.
export function rehearsalComplete(e: Evidence) {
  if (!Array.isArray(e.rounds) || e.rounds.length !== 1 || !whole(e)) return false;
  const [round] = e.rounds;
  if (round.round !== 1 || !Array.isArray(round.latencies) || round.latencies.length !== queries.length ||
    !round.latencies.every(fullySampled)) return false;
  return judge({...e, formal: true, rounds: [1, 2, 3].map(n => ({...round, round: n}))}) !== 'NOT EVALUATED';
}

export function judge(e: Partial<Evidence>): Status {
  if (e.valid !== true || e.formal !== true || !verifiedBackfill(e.backfill, 1_000_000) || !Array.isArray(e.rounds) || !Array.isArray(e.plans) ||
    !Array.isArray(e.complete) || !e.restore || !Array.isArray(e.restore.complete) ||
    !e.denials || !Array.isArray(e.denials.checks) || !e.denials.plan ||
    ![e.rounds, e.plans, e.complete, e.restore.complete, e.denials.checks].every(dense)) return 'NOT EVALUATED';
  const ids = queries.map(([id]) => id);
  const accepted = ids.filter(accepts);
  if (e.rounds.length !== 3 || e.rounds.some((round, index) => round?.round !== index + 1 ||
    !Array.isArray(round.latencies) || round.latencies.length !== ids.length || !dense(round.latencies) ||
    round.latencies.some((l, i) => l?.query !== ids[i] || !sampleValid(l)))) return 'NOT EVALUATED';
  if (e.plans.length !== accepted.length || e.plans.some((plan, i) => plan.query !== accepted[i] ||
    typeof plan.searchIndex !== 'boolean' || typeof plan.seqScanMessages !== 'boolean')) return 'NOT EVALUATED';
  const complete = reportStatus(e.complete);
  const restored = reportStatus(e.restore.complete);
  if (complete === 'NOT EVALUATED' || restored === 'NOT EVALUATED' ||
    !e.complete.some(q => q.actors.some(actor => actor.expectedOlderThan180Days > 0)) ||
    !Number.isFinite(e.restore.restoreMs) || e.restore.restoreMs < 0 ||
    ![e.restore.before, e.restore.after].every(value => typeof value === 'string' && /^\d+\|[a-f0-9]{32}$/.test(value)) ||
    ![e.restore.termRows, e.restore.expectedTermRows].every(n => Number.isSafeInteger(n) && n >= 0) ||
    !termEvidence(e.restore.terms) || !validRls(e.restore.rls?.settings) ||
    !directRlsRecorded(e.restore.rls?.cleanup) || !directRlsRecorded(e.denials.measuredRls) ||
    typeof e.denials.plan.searchIndex !== 'boolean' ||
    e.denials.checks.length !== denialCases.length * 2 || e.denials.checks.some((c, i) => {
      const fixture = denialCases[Math.floor(i / 2)];
      const {expected, expectedRejection} = denialExpectation(fixture);
      return c?.case !== fixture.name || c.forced !== Boolean(i % 2) || typeof c.equal !== 'boolean' ||
        !Array.isArray(c.found) || !Array.isArray(c.expected) || JSON.stringify(c.expected) !== JSON.stringify(expected) ||
        !validRejection(c.rejection) || c.expectedRejection !== expectedRejection;
    })) return 'NOT EVALUATED';
  return e.rounds.some(r => r.latencies.some(l => accepts(l.query)
    ? 'p95' in l && l.p95 > criteria.p95LimitMs
    : 'sqlError' in l || l.outcomes?.some(outcome => outcome !== shortError))) ||
    e.plans.some(p => p.seqScanMessages || !p.searchIndex) || complete === 'FAIL' || restored === 'FAIL' ||
    !e.restore.before.startsWith('1000|') || e.restore.before !== e.restore.after ||
    e.restore.termRows !== e.restore.expectedTermRows || !termsMatch(e.restore.terms, 1000, e.restore.termRows) ||
    e.restore.rls.cleanup !== directRlsExpected || e.denials.measuredRls !== directRlsExpected ||
    e.denials.checks.some(c => !c.equal || c.rejection !== c.expectedRejection || c.paginationError ||
      JSON.stringify(c.found) !== JSON.stringify(c.expected)) || !e.denials.plan.searchIndex ? 'FAIL' : 'PASS';
}

function sampleValid(l: Sample) {
  if (!accepts(l.query)) {
    if (!Array.isArray(l.outcomes) || !l.outcomes.every(outcome => typeof outcome === 'string' && outcome.length > 0)) return false;
    if ('sqlError' in l) return typeof l.sqlError === 'string' && l.sqlError.length > 0;
    if (l.outcomes.length !== criteria.samplesPerQueryRound) return false;
  }
  if (!('n' in l)) return false;
  return l.n === criteria.samplesPerQueryRound &&
    [l.p50, l.p95, l.p99].every(n => Number.isFinite(n) && n >= 0) && l.p50 <= l.p95 && l.p95 <= l.p99;
}
