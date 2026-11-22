import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CommandTimeoutError, SqlStatementTimeoutError } from './bench.ts';
import { denialCases, probe } from './definer.ts';
import { appSessionSettings, hash, settings, snapshot as v13 } from './manifest.ts';
import { queries } from './queries.ts';
import { channel, epoch, generate, org, uuid } from './seed.ts';
import { accepts, completeness, denialExpectation, denials, judge, rehearsalComplete, shortIds, type Evidence } from './d3r/acceptance.ts';
import { expectedTerms, insertSql, verifyTerms } from './d3r/backfill.ts';
import { allPages, planFacts, prepare } from './d3r/engine.ts';
import { argumentsForPostgres, loadManifest, removedSettings } from './d3r/manifest.ts';
import { actors, benchmarkScript, pageSize, pgbenchFormat, productionPath, readSource, sources, term, tokens } from './d3r/path.ts';
import { options, outputPath, resetMeasured, warmup } from './d3r/run.ts';
import { directRls, directRlsExpected, searchTables, verifyRls } from './d3r/rls.ts';
import { loadBackfill, preserveSnapshot, receiptFile, removeSnapshot, snapshotFile, snapshotIdentity, snapshotLaunch } from './d3r/snapshot.ts';
import { timeQuery } from './d3r/timing.ts';

test('v15 freezes the approved settings and every production migration while preserving v13', () => {
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
  assert.deepEqual(frozen.setup.forceSearchRls.split('\n'),
    searchTables.map(table => `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY;`));
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
    'left(token, 3)', '\\if :run_page', 'FROM unnest(:scopes::uuid[])', 'LIMIT :size::bigint + 1', 'COMMIT'];
  let after = -1;
  for (const part of ordered) {
    const index = script.indexOf(part, after + 1);
    assert.ok(index > after, part);
    after = index;
  }
});

test('Rust scalar and whitespace semantics preserve all five frozen rejections', () => {
  assert.deepEqual(queries.filter(([id]) => shortIds.includes(id)).map(([, raw]) => raw), ['開', '麒', 'a', 'ø', '🦉']);
  for (const [id, raw] of queries.filter(([id]) => shortIds.includes(id))) {
    assert.equal(term(tokens(raw)), null);
    const script = benchmarkScript(productionPath().page, raw, true);
    assert.match(script, /char_length\(token\) >= 2/);
    assert.match(script, /THEN 'search_query_too_short'/);
    assert.match(script, /COMMIT;\n\\shell echo d3r-outcome :outcome$/);
    assert.doesNotMatch(script, /1 \/|guard/);
    assert.doesNotMatch(benchmarkScript(productionPath().page, raw), /\\shell/, id);
  }
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

function rlsRecord(unforced?: string) {
  return verifyRls(sql => {
    if (sql.includes('pg_roles')) return 'fukulow_app|f|f\n0\n0';
    if (sql.includes('pg_class')) {
      for (const table of searchTables) assert.ok(sql.includes(`'public.${table}'::regclass`));
      assert.match(sql, /c.relrowsecurity, c.relforcerowsecurity, row_security_active\(c.oid\)/);
      return JSON.stringify(Object.fromEntries(searchTables.map(table => [table, [true, table !== unforced, true]])));
    }
    if (sql.includes('json_object_agg')) return JSON.stringify(appSessionSettings);
    return '0';
  }, appSessionSettings);
}

function backfillRecord(messages: number) {
  const termRows = messages * 4;
  return {durationMs: 1, walBytes: 1000, tableBytes: 2000, termRows, inserted: termRows,
    indexes: {message_search_terms_lookup: 3000, message_search_terms_maintenance: 1000},
    verification: {checked: messages, expectedTermRows: termRows, mismatches: 0, equal: true, durationMs: 1}};
}

function evidence(): Evidence {
  const complete = queries.map(([query]) => ({query, actors: actors.map(actor => {
    const rejection = actor === 6 ? 'organization_unavailable' : accepts(query) ? null : 'search_query_too_short';
    const rows = rejection ? 0 : 1;
    return {actor, actualRows: rows, expectedRows: rows, expectedOlderThan180Days: rows,
      actualHash: hash(''), expectedHash: hash(''), rejection, expectedRejection: rejection, paginationError: undefined, equal: true};
  })}));
  return {valid: true, formal: true, backfill: backfillRecord(1_000_000),
    rounds: [1, 2, 3].map(round => ({round, latencies: queries.map(([query]) => ({
      query, n: 100, p50: 200, p95: accepts(query) ? 500 : 800, p99: 1000,
      ...(accepts(query) ? {} : {outcomes: Array<string>(100).fill('search_query_too_short')}),
    }))})),
    plans: queries.filter(([id]) => accepts(id)).map(([query]) => ({query, searchIndex: true, seqScanMessages: false})),
    denials: {checks: denialCases.flatMap(c => [false, true].map(forced => {
      const {expected, expectedRejection} = denialExpectation(c);
      return {case: c.name, forced, equal: true, found: [...expected], expected, rejection: expectedRejection, expectedRejection,
        paginationError: undefined};
    })), measuredRls: directRlsExpected, plan: {searchIndex: true, seqScanMessages: false, executionMs: 1, explain: []}},
    complete,
    restore: {before: '1000|' + 'a'.repeat(32), after: '1000|' + 'a'.repeat(32), restoreMs: 1,
      termRows: 4000, expectedTermRows: 4000, terms: backfillRecord(1000).verification,
      rls: {settings: rlsRecord(), cleanup: directRlsExpected}, complete},
  };
}

test('formal verdict requires complete evidence, including restore and each accepted round', () => {
  assert.equal(judge(evidence()), 'PASS');
  for (const field of ['valid', 'formal'] as const) {
    assert.equal(judge({...evidence(), [field]: false}), 'NOT EVALUATED');
  }
  assert.equal(judge({...evidence(), restore: undefined}), 'NOT EVALUATED');
  const failed = evidence();
  const latency = failed.rounds[2].latencies.find(l => accepts(l.query))!;
  assert.ok('p95' in latency);
  latency.p95 = 501;
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
  badRestore.restore.terms.mismatches = 1;
  assert.equal(judge(badRestore), 'FAIL');
});

test('rehearsal completeness uses the formal checks on one round and never reports a verdict', () => {
  const one = {...evidence(), formal: false, rounds: [evidence().rounds[0]]};
  assert.equal(rehearsalComplete(one), true);
  const failing = {...one, rounds: [structuredClone(one.rounds[0])]};
  const latency = failing.rounds[0].latencies.find(l => accepts(l.query))!;
  assert.ok('p95' in latency);
  latency.p95 = 501;
  assert.equal(rehearsalComplete(failing), true, 'a slow rehearsal is complete, not judged');
  assert.equal(rehearsalComplete({...one, rounds: evidence().rounds}), false);
  const short = {...one, rounds: [structuredClone(one.rounds[0])]};
  short.rounds[0].latencies.pop();
  assert.equal(rehearsalComplete(short), false);
  assert.equal(rehearsalComplete({...one, restore: undefined} as unknown as Evidence), false);
  assert.equal(rehearsalComplete({...one, valid: false}), false);
});

test('five modes and output preflight can be checked without Docker', () => {
  assert.throws(() => options([]), /--from-backfill/);
  assert.deepEqual(options(['--from-backfill=/tmp/source', '--out=/tmp/next']),
    {mode: 'formal', output: '/tmp/next', fromBackfill: '/tmp/source'});
  assert.equal(options(['--cleanup', '--from-backfill=/tmp/source']).mode, 'cleanup');
  assert.throws(() => options(['--smoke', '--from-backfill=/tmp/source']));
  assert.throws(() => options(['--backfill-only', '--from-backfill=/tmp/source']));
  assert.equal(options(['--smoke']).mode, 'smoke');
  assert.equal(options(['--backfill-only']).mode, 'backfill-only');
  assert.equal(options(['--rehearsal']).mode, 'rehearsal');
  assert.throws(() => options(['--rehearsal', '--from-backfill=/tmp/source']));
  assert.throws(() => options(['--rehearsal', '--smoke']));
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

test('all five search tables must have enabled, forced and active RLS', () => {
  assert.equal(Object.keys(rlsRecord().tables).length, 5);
  for (const table of searchTables) assert.throws(() => rlsRecord(table), /RLS settings differ/);
});

test('direct RLS probes keep both search tables and both positive controls on one connection', () => {
  const calls: string[] = [];
  const record = directRls(sql => { calls.push(sql); return directRlsExpected; });
  assert.equal(calls.length, 1);
  assert.equal(record, directRlsExpected);
  const statements = calls[0].split(';').map(s => s.trim()).filter(Boolean);
  const probes = statements.filter(s => s.startsWith('SELECT EXISTS'));
  assert.equal(probes.length, 7);
  for (const sql of probes) assert.match(sql, /public\.messages .*public\.message_search_terms/s);
  assert.ok(probes[0].includes(org(1)));
  assert.ok(probes[1].includes(org(2)) && probes[3].includes(org(2)));
  const postCommit = statements.filter((sql, i) => sql.startsWith('SELECT EXISTS') && statements[i - 1] === 'COMMIT');
  assert.deepEqual(postCommit, [probes[2], probes[4], probes[6]]);

  for (const target of ['measured', 'restored']) {
    const missing = evidence();
    const failed = evidence();
    if (target === 'measured') {
      Reflect.deleteProperty(missing.denials, 'measuredRls');
      failed.denials.measuredRls = directRlsExpected.replace('f|f', 't|f');
    } else {
      Reflect.deleteProperty(missing.restore, 'rls');
      failed.restore.rls.cleanup = directRlsExpected.replace('f|f', 'f|t');
    }
    assert.equal(judge(missing), 'NOT EVALUATED');
    assert.equal(judge(failed), 'FAIL');
  }
});

test('the formal verdict checks backfill records, fixture controls and malformed latency evidence', () => {
  for (const field of ['durationMs', 'walBytes', 'tableBytes', 'indexes', 'termRows', 'verification']) {
    const missing = evidence();
    Reflect.deleteProperty(missing.backfill, field);
    assert.equal(judge(missing), 'NOT EVALUATED', field);
  }
  const partial = evidence();
  partial.backfill.verification.checked--;
  assert.equal(judge(partial), 'NOT EVALUATED');
  const mismatched = evidence();
  mismatched.backfill.verification.mismatches++;
  assert.equal(judge(mismatched), 'NOT EVALUATED');
  for (const latencies of [undefined, null, {}, 'missing']) {
    const malformed = evidence();
    Reflect.set(malformed.rounds[0], 'latencies', latencies);
    assert.equal(judge(malformed), 'NOT EVALUATED');
  }
  const wrongControl = evidence();
  assert.ok(wrongControl.denials.checks[0].expected.length > 0);
  wrongControl.denials.checks[0].found = [];
  assert.equal(judge(wrongControl), 'FAIL');
  wrongControl.denials.checks[0].expected = [];
  assert.equal(judge(wrongControl), 'NOT EVALUATED');
  const wrongRejection = evidence();
  const deactivated = wrongRejection.denials.checks.find(check => check.expectedRejection === 'organization_unavailable')!;
  deactivated.rejection = null;
  assert.equal(judge(wrongRejection), 'FAIL');
  deactivated.expectedRejection = null;
  assert.equal(judge(wrongRejection), 'NOT EVALUATED');
});

test('the timed short-query path distinguishes actual rejection, acceptance, SQL error and missing output', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-timed-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const dest = join(dir, 'short');
  const metrics = {n: 100, p50: 1, p95: 2, p99: 3, tps: 1, wallMs: 5};
  for (const [outcome, verdict] of [['search_query_too_short', 'PASS'], ['accepted', 'FAIL'],
    ['organization_unavailable', 'FAIL'], ['', 'NOT EVALUATED'], ['ERROR: syntax error', 'FAIL']]) {
    const sample = await timeQuery('unused', 'measured', productionPath().page, 'ja1-frequent', '開', true, dest, 20, 5,
      async (_container, _db, script) => {
        assert.match(script, /d3r-outcome :outcome/);
        const sqlError = outcome.startsWith('ERROR:');
        writeFileSync(dest + '.txt', sqlError ? `pgbench: error: client 0 script 0 aborted in command 7 query 0: ${outcome}\n`
          : outcome ? `d3r-outcome ${outcome}\n`.repeat(100) : '');
        if (sqlError) throw new Error('docker pgbench failed; entire run invalid');
        return metrics;
      });
    const recorded = evidence();
    recorded.rounds[0].latencies[0] = sample;
    assert.equal(judge(recorded), verdict, outcome);
  }
  await assert.rejects(timeQuery('unused', 'measured', productionPath().page, 'ja1-frequent', '開', true, dest, 20, 5,
    async () => {
      writeFileSync(dest + '.txt', 'pgbench: error: could not connect to server\n');
      throw new Error('docker pgbench failed; entire run invalid');
    }), /pgbench failed/);
  for (const error of [new SqlStatementTimeoutError('SQL statement_timeout'), new CommandTimeoutError('docker cp timed out'),
    new Error('docker pgbench timed out'), new Error('Invalid benchmark samples')]) {
    await assert.rejects(timeQuery('unused', 'measured', productionPath().page, 'ja1-frequent', '開', true, dest, 20, 5,
      async () => {
        writeFileSync(dest + '.txt', 'pgbench: error: client 0 script 0 aborted in command 7 query 0: ERROR: canceling statement due to statement timeout\n');
        throw error;
      }), actual => actual === error);
  }
});

test('each round creates a database from base before restart and warms each query in a fresh session', async () => {
  const setup: string[] = [];
  const sessions: string[][] = [];
  for (let i = 0; i < 3; i++) {
    await resetMeasured(sql => { setup.push(sql); return ''; }, async () => { setup.push('restart'); });
    await warmup(productionPath().page, [['a', '開'], ['b', '開発']], 1, async body => {
      const calls: string[] = [];
      sessions.push(calls);
      await body(async sql => {
        calls.push(sql);
        return sql.startsWith('BEGIN') ? [org(1), JSON.stringify([[channel(1, 0)], true]), '"開"'].join('\n') : '';
      });
    });
  }
  assert.deepEqual(setup, Array.from({length: 3}, () => ['CREATE DATABASE measured TEMPLATE base;', 'restart']).flat());
  assert.equal(sessions.length, 6);
  for (const [i, calls] of sessions.entries()) {
    assert.equal(calls.length, 3);
    assert.match(calls[0], /^PREPARE /);
    assert.ok(calls[1].includes(i % 2 === 0 ? "'開'" : "'開発'"));
    assert.equal(calls[2], 'COMMIT;');
  }
});

test('formal startup requires the completed backfill receipt and exact snapshot; cleanup deletes only the archive', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-snapshot-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const archive = join(dir, snapshotFile);
  const manifestHash = 'frozen-manifest';
  const load = () => loadBackfill(dir, manifestHash, 1_000_000, 1000);
  await assert.rejects(load, /ENOENT/);
  writeFileSync(archive, 'fake tar data');
  const receipt = {manifestHash, snapshot: {file: snapshotFile, systemIdentifier: '123', ...await snapshotIdentity(archive)},
    records: {base: backfillRecord(1_000_000), small: backfillRecord(1000), denial: backfillRecord(20_011)}, rls: rlsRecord()};
  const writeReceipt = (runKind = 'backfill-only') => {
    writeFileSync(join(dir, receiptFile), JSON.stringify(receipt));
    writeFileSync(join(dir, 'finished.json'), JSON.stringify({manifestHash, runKind, backfillReceiptHash: hash(JSON.stringify(receipt))}));
    writeFileSync(join(dir, 'run-status.json'), JSON.stringify({manifestHash, valid: true, cleanupVerified: true}));
  };
  writeReceipt('smoke');
  await assert.rejects(load, /completed, verified backfill/);
  writeReceipt();
  assert.deepEqual((await load()).receipt, receipt);
  await assert.rejects(loadBackfill(dir, 'different-manifest', 1_000_000, 1000), /completed, verified backfill/);
  receipt.records.base.verification.mismatches = 1;
  writeReceipt();
  await assert.rejects(load, /Invalid backfill verification/);
  receipt.records.base.verification.mismatches = 0;
  writeReceipt();
  const launch = snapshotLaunch(dir);
  assert.match(launch.options[1], /target=\/backfill,readonly/);
  assert.match(launch.args[1], /tar -xpf \/backfill\/verified-cluster\.tar -C "\$PGDATA"/);
  writeFileSync(archive, 'bad! tar data');
  await assert.rejects(load, /snapshot identity mismatch/);
  writeFileSync(archive, 'fake tar data');
  removeSnapshot((await load()).directory);
  await assert.rejects(load, /ENOENT/);
  assert.equal(JSON.parse(readFileSync(join(dir, receiptFile), 'utf8')).manifestHash, manifestHash);
});

for (const scenario of ['changed-before-hash', 'interrupted-during-hash', 'changed-after-hash'] as const) {
  test(`formal startup records invalid status and cleans staging when ${scenario}`, {timeout: 10_000}, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'd3r-formal-test-'));
    t.after(() => rmSync(dir, {recursive: true, force: true}));
    const source = join(dir, 'preserved');
    const archive = join(source, snapshotFile);
    const out = join(dir, 'results');
    const staged = join(out, 'restore-snapshot');
    const extracting = join(dir, 'extraction-input');
    const hashing = join(dir, 'hashing');
    const preload = join(dir, 'hash-hook.mjs');
    const {sha256: manifestHash, frozen: {image, performance: {rows, restoreRows}}} = loadManifest();
    mkdirSync(source);
    writeFileSync(archive, 'original tar');
    const receipt = {manifestHash, snapshot: {file: snapshotFile, systemIdentifier: '123', ...await snapshotIdentity(archive)},
      records: {base: backfillRecord(rows), small: backfillRecord(restoreRows), denial: backfillRecord(20_011)}, rls: rlsRecord()};
    writeFileSync(join(source, receiptFile), JSON.stringify(receipt));
    writeFileSync(join(source, 'finished.json'), JSON.stringify({manifestHash, runKind: 'backfill-only',
      backfillReceiptHash: hash(JSON.stringify(receipt))}));
    writeFileSync(join(source, 'run-status.json'), JSON.stringify({manifestHash, valid: true, cleanupVerified: true}));
    if (scenario === 'changed-before-hash') writeFileSync(archive, 'modified tar');
    if (scenario === 'interrupted-during-hash') writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
fs.createReadStream = () => {
  fs.writeFileSync(${JSON.stringify(hashing)}, '');
  setInterval(() => {}, 1000);
  return new PassThrough();
};
syncBuiltinESMExports();
`);
    writeFileSync(join(dir, 'docker'), `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'image') {
  writeFileSync(${JSON.stringify(archive)}, 'modified tar');
  console.log('sha256:' + 'a'.repeat(64));
}
if (args[0] === 'run') {
  const mount = args.find(arg => arg.endsWith(',target=/backfill,readonly'));
  const directory = /^type=bind,"source=(.+)",target=/.exec(mount)[1];
  writeFileSync(${JSON.stringify(extracting)}, readFileSync(directory + '/${snapshotFile}'));
  process.exit(1);
}
`, {mode: 0o700});
    const child = spawn(process.execPath, [fileURLToPath(new URL('./d3r/run.ts', import.meta.url)),
      `--from-backfill=${source}`, `--out=${out}`], {env: {...process.env, PATH: `${dir}:${process.env.PATH}`,
      ...(scenario === 'interrupted-during-hash' ? {NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`} : {})},
      stdio: ['ignore', 'pipe', 'pipe']});
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    const closed = once(child, 'close');
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { stderr += String(data); });
    if (scenario === 'interrupted-during-hash') {
      while (!existsSync(hashing)) {
        t.signal.throwIfAborted();
        assert.equal(child.exitCode, null, stderr);
        await setTimeout(10);
      }
      assert.ok(existsSync(out));
      assert.ok(child.kill('SIGTERM'));
    }
    const exitCode = scenario === 'interrupted-during-hash' ? 143 : 1;
    assert.deepEqual(await closed, [exitCode, null], stderr);
    assert.match(stdout, /NOT EVALUATED/);
    const status = JSON.parse(readFileSync(join(out, 'run-status.json'), 'utf8'));
    assert.deepEqual(status, {manifestHash, valid: false, cleanupVerified: true, exitCode,
      ...(scenario === 'changed-after-hash' ? {image: {reference: image, id: 'sha256:' + 'a'.repeat(64)}} : {})});
    assert.equal(existsSync(staged), false);
    assert.equal(existsSync(join(out, 'summary.json')), false);
    if (scenario === 'changed-after-hash') {
      assert.equal(readFileSync(archive, 'utf8'), 'modified tar');
      assert.equal(readFileSync(extracting, 'utf8'), 'original tar');
    } else {
      assert.equal(existsSync(extracting), false);
      if (scenario === 'changed-before-hash') assert.match(stderr, /Backfill snapshot identity mismatch/);
    }
  });
}

test('snapshot creation verifies the physical backup before publishing the archive', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-snapshot-create-test-'));
  const previousPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = previousPath;
    rmSync(dir, {recursive: true, force: true});
  });
  const log = join(dir, 'calls');
  writeFileSync(join(dir, 'docker'), `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[2] === 'pg_verifybackup' && !existsSync(${JSON.stringify(log + '.allow')})) process.exit(1);
if (args[2] === 'tar') process.stdout.write('physical archive');
`, {mode: 0o700});
  process.env.PATH = dir + ':' + previousPath;
  await assert.rejects(preserveSnapshot('owned', dir, '12345'), /docker exec failed/);
  assert.throws(() => readFileSync(join(dir, snapshotFile)), /ENOENT/);
  writeFileSync(log + '.allow', '');
  const receipt = await preserveSnapshot('owned', dir, '12345');
  assert.deepEqual(receipt, {file: snapshotFile, systemIdentifier: '12345',
    bytes: 'physical archive'.length, sha256: hash('physical archive')});
  const calls: string[][] = readFileSync(log, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(args => args[2]), ['pg_basebackup', 'pg_verifybackup', 'pg_basebackup', 'pg_verifybackup', 'tar']);
  assert.deepEqual(calls[2], ['exec', 'owned', 'pg_basebackup', '-U', 'fukulow', '-D', '/tmp/backfill', '-X', 'stream']);
});

test('pgbench script keeps no variable-like colon inside string literals', () => {
  const page = productionPath().page;
  const bound = pgbenchFormat(page);
  assert.ok(page.includes(`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`));
  assert.ok(bound.includes(`('YYYY-MM-DD"T"HH24' || chr(58) || 'MI' || chr(58) || 'SS.US"Z"')`));
  for (const literal of benchmarkScript(page, '開発 API', true).match(/'(?:[^']|'')*'/g) ?? [])
    assert.doesNotMatch(literal, /:[A-Za-z_]/, literal);
  assert.throws(() => pgbenchFormat(page.replace(`'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`, `'HH24:MI'`)), /format changed/);
});
