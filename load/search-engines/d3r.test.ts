import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { denialCases, probe } from './definer.ts';
import { hash, settings, snapshot as v13 } from './manifest.ts';
import { queries } from './queries.ts';
import { channel, epoch, generate, org, uuid } from './seed.ts';
import { accepts, completeness, denials, judge, shortIds, type Evidence } from './d3r/acceptance.ts';
import { expectedTerms, insertSql, verifyTerms } from './d3r/backfill.ts';
import { allPages, planFacts, prepare } from './d3r/engine.ts';
import { argumentsForPostgres, loadManifest, removedSettings } from './d3r/manifest.ts';
import { actors, benchmarkScript, pageSize, productionPath, readSource, sources, term, tokens } from './d3r/path.ts';
import { options, outputPath } from './d3r/run.ts';

test('v14 freezes the approved settings and every production migration while preserving v13', () => {
  const {sha256, frozen} = loadManifest();
  const baseline = v13();
  assert.equal(sha256, hash(JSON.stringify(frozen)));
  assert.equal(frozen.image, 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42');
  assert.deepEqual(frozen.performance, {
    ...Object.fromEntries(Object.entries(baseline.performance).filter(([key]) =>
      !['order', 'writeTransactions', 'writeWarmTransactions'].includes(key))),
  });
  assert.equal(frozen.queryPath.history, 'full');
  assert.equal(frozen.queryPath.role, 'fukulow_app');
  assert.equal(frozen.queryPath.pageSize, 20);
  assert.deepEqual(frozen.generator, baseline.generator);
  assert.deepEqual(frozen.settings, Object.fromEntries(Object.entries(settings).filter(([name]) => !(name in removedSettings))));
  assert.ok(Object.values(frozen.removedSettings).every(reason => reason.length > 0));
  assert.equal(argumentsForPostgres.length, 1 + (Object.keys(frozen.settings).length - 1) * 2);
  assert.equal(argumentsForPostgres.some(arg => arg.includes('pgroonga')), false);
  assert.deepEqual(frozen.migrations, readdirSync(new URL('../../server/migrations/', import.meta.url))
    .filter(name => name.endsWith('.sql')).sort().map(name => 'server/migrations/' + name));
  for (const [path, digest] of Object.entries(productionPath().hashes)) {
    assert.equal(frozen.sourceHashes.find(source => source.path === path)?.sha256, digest);
  }
});

test('production d3r steps and SQL bind order have an independent source guard', () => {
  const path = productionPath();
  assert.equal(path.hashes[sources.engine], '12777dcfb118b9481d32c57bc01614e9f9749549c8a7020bed6d11d3827f0aba');
  assert.equal(path.page + ';', readSource(sources.page).trim());
  assert.match(prepare(path.page), /uuid, uuid\[\], text, text\[\], text, uuid, bigint/);
  const script = benchmarkScript(path.page, '開発 API', true);
  const ordered = ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'fukulow.organization_id',
    "SET LOCAL statement_timeout = '2s'", 'membership_revision = 0', 'cm.membership_revision = u.membership_revision',
    'u.id IN(c.lower_member_id,c.higher_member_id)', 'SET LOCAL plan_cache_mode = force_generic_plan',
    'fukulow_search_normalize(:raw_query)', 'ORDER BY char_length(token) DESC, position DESC',
    'left(token, 3)', '\\if :accepted', 'FROM unnest(:scopes::uuid[])', 'LIMIT :size::bigint + 1', 'COMMIT'];
  let after = -1;
  for (const part of ordered) {
    const index = script.indexOf(part, after + 1);
    assert.ok(index > after, part);
    after = index;
  }
});

test('Rust scalar and whitespace semantics preserve all five frozen rejections', () => {
  assert.deepEqual(queries.filter(([id]) => shortIds.includes(id)).map(([, raw]) => raw), ['開', '麒', 'a', 'ø', '🦉']);
  for (const [, raw] of queries.filter(([id]) => shortIds.includes(id))) assert.equal(term(tokens(raw)), null);
  assert.deepEqual(tokens(' \u0085開発\u3000 API\u00a0'), ['開発', 'API']);
  assert.deepEqual(tokens('\ufeff開発'), ['\ufeff開発']);
  assert.equal(term(['abcd', '🦉🦉𐐀x']), '🦉🦉𐐀');
  assert.equal(term(['x', '開発']), '開発');
  assert.equal(queries.filter(([id]) => accepts(id)).length, 23);
});

test('frozen generator has full-history rows, including the 180-day boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-fixture-test-'));
  try {
    const path = join(dir, 'seed.tsv');
    const stats = generate(path, 1000);
    const dates = readFileSync(path, 'utf8').trimEnd().split('\n').map(line => Date.parse(line.split('\t')[7]));
    const cutoff = epoch - 180 * 86400000;
    assert.equal(stats.old, dates.filter(date => date < cutoff).length);
    assert.ok(Number(stats.old) >= 100);
    assert.ok(dates.includes(cutoff));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('term backfill uses the production insert and independently verifies each Message', async () => {
  const after = uuid(42);
  const sql = insertSql(readSource(sources.engine), 2, after);
  assert.match(sql, /public\.fukulow_search_terms\(m.body\)/);
  assert.match(sql, /m.id=ANY\(ARRAY\(SELECT id FROM batch\)\) AND NOT m.deleted/);
  assert.ok(sql.includes(org(2)) && sql.includes(after));
  const knownTerms = ['aa', 'aa🦉', 'a🦉', 'a🦉a', '🦉a'];
  const digest = createHash('sha256').update(knownTerms.map(t => [...t].length + t).join('')).digest('hex');
  assert.deepEqual(expectedTerms('aa🦉a'), {count: 5, sha256: digest});
  assert.equal(expectedTerms('aaaa').count, 2);
  assert.equal(expectedTerms('🦉').count, 0);
  for (const corrupted of [false, true]) {
    let fetched = false;
    const result = await verifyTerms(async query => {
      assert.doesNotMatch(query, /fukulow_search_terms\(m.body\)/);
      if (!fetched && query.includes(org(1))) {
        fetched = true;
        return JSON.stringify([after, 'aa🦉a', 5, corrupted ? 'bad digest' : digest, true]);
      }
      return '';
    }, 1, 5);
    assert.equal(result.equal, !corrupted);
  }
});

function scriptedPages(pages: string[], normalized = '開発 API') {
  const calls: string[] = [];
  const app = async (text: string) => {
    calls.push(text);
    if (text.startsWith('BEGIN')) return [org(1), JSON.stringify([[channel(1, 0)], true]), JSON.stringify(normalized)].join('\n');
    if (text.startsWith('EXECUTE')) return pages.shift() ?? '';
    assert.equal(text, 'COMMIT;');
    return '';
  };
  return {calls, app};
}

test('production pagination consumes the lookahead once and uses the twentieth key', async () => {
  const at = '2026-01-01T00:00:00.000000Z';
  const lines = Array.from({length: pageSize + 1}, (_, i) => `${uuid(30 - i)}|${at}`);
  const {calls, app} = scriptedPages([lines.join('\n'), lines.at(-1)!]);
  const result = await allPages(app, [1, 2], '開発 API');
  assert.deepEqual(result.ids, lines.map(line => line.split('|')[0]));
  const executions = calls.filter(line => line.startsWith('EXECUTE'));
  assert.equal(executions.length, 2);
  assert.ok(executions[0].includes("'API', ARRAY['開発','API']"));
  assert.ok(executions[1].includes(`'${at}', '${uuid(11)}', 20`));
  const duplicate = scriptedPages([lines.join('\n'), lines[19]]);
  assert.ok((await allPages(duplicate.app, [1, 2], '開発 API')).paginationError);
  const rejected = scriptedPages([], '🦉');
  assert.equal((await allPages(rejected.app, [1, 2], '🦉')).rejection, 'search_query_too_short');
  assert.equal(rejected.calls.some(line => line.startsWith('EXECUTE')), false);
});

test('reference scans full history, requires every token and checks the six frozen Members', async () => {
  const old = '2026-01-01T00:00:00.000000Z';
  const publicId = uuid(1);
  const privateId = uuid(2);
  let state = 'reference';
  let scanned = false;
  const app = async (sql: string) => {
    if (state === 'reference') {
      if (sql.includes('SELECT to_json(normalized)')) return JSON.stringify(sql.includes('開発 API') ? '開発 api' : 'unmatched');
      if (sql.includes('FROM public.messages')) {
        assert.doesNotMatch(sql, /message_search_terms|created_at >=/);
        if (scanned) return '';
        scanned = true;
        return [
          [publicId, channel(1, 0), old, 'api starts before 開発'],
          [privateId, channel(1, 21), old, 'api before 開発'],
          [uuid(3), channel(1, 0), old, 'api only'],
        ].map(row => JSON.stringify(row)).join('\n');
      }
      if (sql === 'COMMIT;') state = 'search';
      return '';
    }
    if (sql.startsWith('BEGIN')) {
      const unavailable = sql.includes(uuid(1106));
      return [org(1), JSON.stringify([[channel(1, 0)], !unavailable]), '"🦉"'].join('\n');
    }
    return '';
  };
  const rows = await completeness(app);
  const space = rows.find(row => row.query === 'space1')!;
  assert.deepEqual(space.actors.map(row => row.expectedRows), [1, 1, 1, 0, 1, 0]);
  assert.deepEqual(space.actors.map(row => row.expectedOlderThan180Days), [1, 1, 1, 0, 1, 0]);
  assert.ok(rows.find(row => row.query === 'scalar')!.actors.every(row => row.equal));
});

test('denials retain every historical case, forced and unforced, and add the older visible control', async () => {
  const app = async (text: string) => {
    if (text.startsWith('BEGIN')) return ['scope', JSON.stringify([[channel(1, 0)], true]), '"denialprobe"'].join('\n');
    if (text.startsWith('EXPLAIN')) return JSON.stringify([{Plan: {'Node Type': 'Index Scan',
      'Index Name': 'message_search_terms_lookup', 'Actual Loops': 1}, 'Execution Time': 1}]);
    return '';
  };
  const result = await denials(app);
  assert.deepEqual(result.checks.map(row => row.case), denialCases.flatMap(row => [row.name, row.name]));
  assert.deepEqual(result.checks.slice(0, 2).map(row => row.forced), [false, true]);
  assert.ok(result.checks[0].expected.includes(probe(4)));
  assert.ok(result.plan.searchIndex);
  assert.equal(planFacts([{Plan: {'Node Type': 'Index Scan', 'Index Name': 'message_search_terms_lookup',
    'Actual Loops': 0}, 'Execution Time': 1}]).searchIndex, false);
});

function evidence(): Evidence {
  const complete = queries.map(([query]) => ({query, actors: actors.map(actor => {
    const rejection = actor === 6 ? 'organization_unavailable' : accepts(query) ? null : 'search_query_too_short';
    const rows = rejection ? 0 : 1;
    return {actor, actualRows: rows, expectedRows: rows, expectedOlderThan180Days: rows,
      actualHash: hash(''), expectedHash: hash(''), rejection, expectedRejection: rejection, paginationError: undefined, equal: true};
  })}));
  return {valid: true, formal: true, backfill: true,
    rounds: [1, 2, 3].map(round => ({round, latencies: queries.map(([query]) => ({
      query, n: 100, p50: 200, p95: accepts(query) ? 500 : 800, p99: 1000,
    }))})),
    plans: queries.filter(([id]) => accepts(id)).map(([query]) => ({query, searchIndex: true, seqScanMessages: false})),
    denials: {checks: denialCases.flatMap(c => [false, true].map(forced => ({
      case: c.name, forced, equal: true, found: [], expected: [], rejection: null, expectedRejection: null,
      paginationError: undefined,
    }))), plan: {searchIndex: true, seqScanMessages: false, executionMs: 1, explain: []}},
    complete, restore: {checksumEqual: true, termsEqual: true, complete},
  };
}

test('formal verdict requires complete evidence, including restore and each accepted round', () => {
  assert.equal(judge(evidence()), 'PASS');
  for (const field of ['valid', 'formal', 'backfill'] as const) {
    assert.equal(judge({...evidence(), [field]: false}), 'NOT EVALUATED');
  }
  assert.equal(judge({...evidence(), restore: undefined}), 'NOT EVALUATED');
  const failed = evidence();
  failed.rounds[2].latencies.find(l => accepts(l.query))!.p95 = 501;
  assert.equal(judge(failed), 'FAIL');
  const plan = evidence();
  plan.plans[0].searchIndex = false;
  assert.equal(judge(plan), 'FAIL');
  const incorrectShort = evidence();
  incorrectShort.complete[0].actors[0].rejection = null;
  assert.equal(judge(incorrectShort), 'FAIL');
  const missing = evidence();
  missing.rounds[1].latencies.pop();
  assert.equal(judge(missing), 'NOT EVALUATED');
  const badRestore = evidence();
  badRestore.restore.termsEqual = false;
  assert.equal(judge(badRestore), 'FAIL');
});

test('three modes and output preflight can be checked without Docker', () => {
  assert.equal(options([]).mode, 'formal');
  assert.equal(options(['--smoke']).mode, 'smoke');
  assert.equal(options(['--backfill-only']).mode, 'backfill-only');
  assert.throws(() => options(['--smoke', '--backfill-only']));
  const dir = mkdtempSync(join(tmpdir(), 'd3r-output-test-'));
  try {
    const out = outputPath(join(dir, 'next'));
    assert.throws(() => outputPath(out, dir), /outside Git/);
    mkdirSync(out);
    assert.throws(() => outputPath(out), /already exists/);
    const broken = join(dir, 'broken');
    symlinkSync(join(dir, 'missing'), broken);
    assert.throws(() => outputPath(broken), /already exists/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
