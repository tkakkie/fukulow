import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CommandTimeoutError, SqlStatementTimeoutError } from './bench.ts';
import { denialCases, probe } from './definer.ts';
import { appSessionSettings, hash, settings, snapshot as baseSnapshot } from './manifest.ts';
import { queries } from './queries.ts';
import { channel, epoch, generate, org, uuid } from './seed.ts';
import { accepts, completeness, denialExpectation, denials, judge, rehearsalComplete, shortIds, type Evidence, type Sample } from './d3r/acceptance.ts';
import { expectedTerms, insertSql, verifyTerms } from './d3r/backfill.ts';
import { allPages, planFacts, prepare } from './d3r/engine.ts';
import { argumentsForPostgres, loadManifest, removedSettings } from './d3r/manifest.ts';
import { actors, benchmarkScript, pageSize, pgbenchFormat, productionPath, readSource, sources, term, tokens } from './d3r/path.ts';
import { claimFile, cleanUpRun, completeRun, discardRehearsalSnapshot, launchFile, measureBlocks, options, outputPath, processStart,
  recordedWarmup, rehearsalHandoff, resetMeasured, stagingDirectory, stopUnlessWhole, warmup, workerOptions, writeLaunch,
  type HandoffSteps } from './d3r/run.ts';
import { directRls, directRlsExpected, searchTables, verifyRls } from './d3r/rls.ts';
import { loadBackfill, preserveSnapshot, receiptFile, removeSnapshot, snapshotFile, snapshotIdentity, snapshotLaunch, stageSnapshot } from './d3r/snapshot.ts';
import { timeQuery } from './d3r/timing.ts';
import { assertHeadroom, dfBytes, dockerDiskArgs, headroomSampler, outputDisk, projectHeadroom, type Disk } from './d3r/headroom.ts';

test('the current d3r manifest freezes the approved settings and every production migration', () => {
  const {sha256, frozen} = loadManifest();
  const baseline = baseSnapshot();
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

test('v14 stays pinned and v15 differs from it only by the rehearsal, the new migration and its sources', () => {
  const v14Text = readFileSync(new URL('./manifest-v14.json', import.meta.url), 'utf8');
  assert.equal(hash(v14Text), '602128371da4975e4a56f2a9e0a5838b0c2a14c4b3f8cd680f3a559ad1b9addd');
  const v14 = JSON.parse(v14Text);
  assert.equal(v14.sha256, 'a7210a32e53b9adacc5fd6951520167ad2171d6f8a6a5b07d3210bdb0f4ba9c5');
  assert.equal(v14.sha256, hash(JSON.stringify(v14.frozen)));
  const {frozen} = pinnedV15();
  const keys = [...new Set([...Object.keys(v14.frozen), ...Object.keys(frozen)])];
  const changed = keys.filter(key => JSON.stringify(v14.frozen[key]) !== JSON.stringify((frozen as Record<string, unknown>)[key]));
  assert.deepEqual(changed.sort(), ['migrations', 'rehearsal', 'sourceHashes', 'version']);
  for (const key of ['generator', 'node', 'image', 'shmBytes', 'settings', 'removedSettings', 'sessionPolicy', 'setup',
    'queryPath', 'performance', 'smoke', 'timing', 'criteria']) assert.deepEqual((frozen as Record<string, unknown>)[key], v14.frozen[key], key);
  assert.equal(v14.frozen.version, 14);
  assert.equal(frozen.version, 15);
  assert.equal(v14.frozen.rehearsal, undefined);
  assert.deepEqual(frozen.rehearsal, {label: 'REHEARSAL / NON-EVALUATION', performance: {rounds: 1},
    evidence: 'never; only completeness against the formal checks is recorded'});
  const added = 'server/migrations/202611221100_unread_counts.sql';
  assert.deepEqual(frozen.migrations, [...v14.frozen.migrations, added].sort());
  const before = new Map<string, string>(v14.frozen.sourceHashes.map((s: {path: string; sha256: string}) => [s.path, s.sha256]));
  assert.ok([...before.keys()].every(path => frozen.sourceHashes.some(source => source.path === path)));
  assert.deepEqual(frozen.sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path), [
    'load/search-engines/d3r/acceptance.ts', 'load/search-engines/d3r/headroom.ts', 'load/search-engines/d3r/labels.ts',
    'load/search-engines/d3r/manifest.ts',
    'load/search-engines/d3r/run.ts', 'load/search-engines/d3r/snapshot.ts', added]);
});

function pinnedV15(): ReturnType<typeof loadManifest> {
  const text = readFileSync(new URL('./manifest-v15.json', import.meta.url), 'utf8');
  assert.equal(hash(text), '1130166b3d772080a2db37da3c03b9c1f71586a39550e78b52f740e35600c1cd');
  const v15 = JSON.parse(text);
  assert.equal(v15.sha256, 'e28d1b584f2e27544ab967ee21f1dd0e0f42c0d3a1c51fbb5c8a92a7b51e1b66');
  assert.equal(v15.sha256, hash(JSON.stringify(v15.frozen)));
  return v15;
}

test('v15 stays pinned and v16 differs from it only by the date, the new migration and its sources', () => {
  const v15 = pinnedV15();
  const {frozen} = pinnedV16();
  const keys = [...new Set([...Object.keys(v15.frozen), ...Object.keys(frozen)])];
  const changed = keys.filter(key => JSON.stringify((v15.frozen as Record<string, unknown>)[key]) !== JSON.stringify((frozen as Record<string, unknown>)[key]));
  assert.deepEqual(changed.sort(), ['date', 'migrations', 'sourceHashes', 'version']);
  assert.equal(v15.frozen.version, 15);
  assert.equal(frozen.version, 16);
  const added = 'server/migrations/202611221101_topics_page.sql';
  assert.deepEqual(frozen.migrations, [...v15.frozen.migrations, added].sort());
  const before = new Map<string, string>(v15.frozen.sourceHashes.map((s: {path: string; sha256: string}) => [s.path, s.sha256]));
  assert.ok([...before.keys()].every(path => frozen.sourceHashes.some(source => source.path === path)));
  assert.deepEqual(frozen.sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path),
    ['load/search-engines/d3r/manifest.ts', added]);
});

function pinnedV16(): ReturnType<typeof loadManifest> {
  const text = readFileSync(new URL('./manifest-v16.json', import.meta.url), 'utf8');
  assert.equal(hash(text), '97a26dd8fd50182108fb5b4974aa8857af42c48a3bb05bfa765409296bf6eef5');
  const v16 = JSON.parse(text);
  assert.equal(v16.sha256, '539a25e180192a1bd542c822abdd02546f711df90223699103d8d84622892088');
  assert.equal(v16.sha256, hash(JSON.stringify(v16.frozen)));
  return v16;
}

function pinnedV17(): ReturnType<typeof loadManifest> {
  const text = readFileSync(new URL('./manifest-v17.json', import.meta.url), 'utf8');
  assert.equal(hash(text), '2753a5aacfffe7fc974baa4b9ae52275540ae2ab110558c1bf0bc5959c987195');
  const v17 = JSON.parse(text);
  assert.equal(v17.sha256, 'd096806e8cedfcbc20e8b638c9f6aad9494908e7603f15d11b724de8a47b3f03');
  assert.equal(v17.sha256, hash(JSON.stringify(v17.frozen)));
  return v17;
}

test('v16 stays pinned and v17 differs from it only by the new migration and its sources', () => {
  const v16 = pinnedV16();
  const {frozen} = pinnedV17();
  const keys = [...new Set([...Object.keys(v16.frozen), ...Object.keys(frozen)])];
  const changed = keys.filter(key => JSON.stringify((v16.frozen as Record<string, unknown>)[key]) !== JSON.stringify((frozen as Record<string, unknown>)[key]));
  assert.deepEqual(changed.sort(), ['migrations', 'sourceHashes', 'version']);
  assert.equal(v16.frozen.version, 16);
  assert.equal(frozen.version, 17);
  const added = 'server/migrations/202611231100_unread_counts_update_first.sql';
  assert.deepEqual(frozen.migrations, [...v16.frozen.migrations, added].sort());
  const before = new Map<string, string>(v16.frozen.sourceHashes.map((s: {path: string; sha256: string}) => [s.path, s.sha256]));
  assert.ok([...before.keys()].every(path => frozen.sourceHashes.some(source => source.path === path)));
  assert.deepEqual(frozen.sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path),
    ['load/search-engines/d3r/manifest.ts', added]);
});

function pinnedV18(): ReturnType<typeof loadManifest> {
  const text = readFileSync(new URL('./manifest-v18.json', import.meta.url), 'utf8');
  assert.equal(hash(text), '094587ccf3aee1068fe0d4af7ca72917e3ec000282ada33fa7580617e2bc9454');
  const v18 = JSON.parse(text);
  assert.equal(v18.sha256, 'a038803ee87a8ef066dccef4b88f6f354ddc4ee45e0efa061b92e9492e7c38c8');
  assert.equal(v18.sha256, hash(JSON.stringify(v18.frozen)));
  return v18;
}

test('v18 records the replay and Search 429 sources with v17 conditions', () => {
  const {version, date, migrations, sourceHashes, ...conditions} = pinnedV18().frozen;
  const {version: previousVersion, date: previousDate, migrations: previousMigrations,
    sourceHashes: previousSources, ...previousConditions} = pinnedV17().frozen;
  assert.equal(version, previousVersion + 1);
  assert.deepEqual([previousDate, date], ['2026-11-23', '2026-11-27']);
  assert.deepEqual(conditions, previousConditions);
  const added = 'server/migrations/202611260620_create_from_messages.sql';
  assert.deepEqual(migrations, [...previousMigrations, added].sort());
  assert.deepEqual(sourceHashes.map(source => source.path), [...previousSources.map(source => source.path), added].sort());
  const before = new Map(previousSources.map(source => [source.path, source.sha256]));
  assert.deepEqual(sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path), [
    '.gitattributes', 'load/search-engines/d3r/manifest.ts', 'load/search-engines/manifest.ts', 'load/search-engines/summarize.ts',
    'deploy/db-grants.sql', 'server/src/messages/search.rs', added,
  ].sort());
});

function pinnedV19(): ReturnType<typeof loadManifest> {
  const text = readFileSync(new URL('./manifest-v19.json', import.meta.url), 'utf8');
  assert.equal(hash(text), 'b53d17065b65c96534bd2f049dee8356a73bdc4224a212e385eafeee53c6c25f');
  const v19 = JSON.parse(text);
  assert.equal(v19.sha256, 'e1daacb402ef6ad4d938634589f189427b38684596f58bf0f6c0fc4702441243');
  assert.equal(v19.sha256, hash(JSON.stringify(v19.frozen)));
  return v19;
}

test('v19 records Message retention with v18 conditions', () => {
  const {version, date, migrations, sourceHashes, ...conditions} = pinnedV19().frozen;
  const {version: previousVersion, date: previousDate, migrations: previousMigrations,
    sourceHashes: previousSources, ...previousConditions} = pinnedV18().frozen;
  assert.equal(version, previousVersion + 1);
  assert.deepEqual([previousDate, date], ['2026-11-27', '2026-11-28']);
  assert.deepEqual(conditions, previousConditions);
  const added = 'server/migrations/202611280001_messages_no_delete.sql';
  assert.deepEqual(migrations, [...previousMigrations, added].sort());
  assert.deepEqual(sourceHashes.map(source => source.path), [...previousSources.map(source => source.path), added].sort());
  const before = new Map(previousSources.map(source => [source.path, source.sha256]));
  assert.deepEqual(sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path),
    ['load/search-engines/d3r/manifest.ts', added]);
});

function pinnedV20(): ReturnType<typeof loadManifest> {
  const text = readFileSync(new URL('./manifest-v20.json', import.meta.url), 'utf8');
  assert.equal(hash(text), 'a844b1b3cfd34eeb40b7eda301e4e3ad7b2fd46a0477848a29d9ec5e42ea3130');
  const v20 = JSON.parse(text);
  assert.equal(v20.sha256, 'b3a47b34bd6b2d587fbe2a30fd6cbcd98da0878052473b8cbabe7b7b254c0907');
  assert.equal(v20.sha256, hash(JSON.stringify(v20.frozen)));
  return v20;
}

test('v20 records the database context refactor with v19 conditions', () => {
  const {version, sourceHashes, ...conditions} = pinnedV20().frozen;
  const {version: previousVersion, sourceHashes: previousSources, ...previousConditions} = pinnedV19().frozen;
  assert.equal(version, previousVersion + 1);
  assert.deepEqual(conditions, previousConditions);
  assert.deepEqual(sourceHashes.map(source => source.path), previousSources.map(source => source.path));
  const before = new Map(previousSources.map(source => [source.path, source.sha256]));
  assert.deepEqual(sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path),
    ['load/search-engines/d3r/manifest.ts', 'server/src/database/context.rs']);
});

test('v21 records typed API errors with v20 conditions', () => {
  const {version, sourceHashes, ...conditions} = loadManifest().frozen;
  const {version: previousVersion, sourceHashes: previousSources, ...previousConditions} = pinnedV20().frozen;
  assert.equal(version, previousVersion + 1);
  assert.deepEqual(conditions, previousConditions);
  assert.deepEqual(sourceHashes.map(source => source.path), previousSources.map(source => source.path));
  const before = new Map(previousSources.map(source => [source.path, source.sha256]));
  assert.deepEqual(sourceHashes.filter(source => before.get(source.path) !== source.sha256).map(source => source.path),
    ['load/search-engines/d3r/manifest.ts', 'server/src/auth.rs', 'server/src/channels.rs']);
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

test('a rehearsal with an aborted or under-sampled benchmark is incomplete; a slow full one is complete', () => {
  const one = (): Evidence => ({...evidence(), formal: false, rounds: [structuredClone(evidence().rounds[0])]});
  const slow = one();
  for (const latency of slow.rounds[0].latencies) if ('p95' in latency) latency.p95 = latency.p99 = 5000;
  assert.equal(rehearsalComplete(slow), true);
  const aborted = one();
  const at = aborted.rounds[0].latencies.findIndex(l => l.query === 'ja1-frequent');
  aborted.rounds[0].latencies[at] = {query: 'ja1-frequent', outcomes: [], sqlError: 'ERROR: canceling statement'};
  assert.equal(judge({...aborted, formal: true, rounds: [1, 2, 3].map(round => ({...aborted.rounds[0], round}))}), 'FAIL',
    'the formal judge counts this abort as a FAIL, so the rehearsal must check samples itself');
  assert.equal(rehearsalComplete(aborted), false);
  const acceptedAbort = one();
  const accepted = acceptedAbort.rounds[0].latencies.findIndex(l => accepts(l.query));
  acceptedAbort.rounds[0].latencies[accepted] = {query: acceptedAbort.rounds[0].latencies[accepted].query, outcomes: [],
    sqlError: 'ERROR: canceling statement'};
  assert.equal(rehearsalComplete(acceptedAbort), false);
  const fewer = one();
  const sample = fewer.rounds[0].latencies.find(l => accepts(l.query))!;
  assert.ok('n' in sample);
  sample.n = 99;
  assert.equal(rehearsalComplete(fewer), false);
  const fewerOutcomes = one();
  const rejected = fewerOutcomes.rounds[0].latencies.find(l => !accepts(l.query))!;
  rejected.outcomes!.pop();
  assert.equal(rehearsalComplete(fewerOutcomes), false);
  assert.equal(rehearsalComplete({...one(), rounds: undefined} as unknown as Evidence), false);
});

test('rehearsal completeness requires whole evidence: no pagination error, hole or missing item', () => {
  const one = (): Evidence => ({...evidence(), formal: false, rounds: [structuredClone(evidence().rounds[0])]});
  assert.equal(rehearsalComplete(one()), true);
  const paged = one();
  paged.complete = structuredClone(paged.complete);
  Object.assign(paged.complete[3].actors[0], {paginationError: 'Search repeated a Message or moved its cursor backwards',
    equal: false, actualRows: 0});
  assert.equal(judge({...paged, formal: true, rounds: [1, 2, 3].map(round => ({...paged.rounds[0], round}))}), 'FAIL',
    'the formal judge counts a partial pagination as a FAIL, so the rehearsal must reject it itself');
  assert.equal(rehearsalComplete(paged), false);
  const restorePaged = one();
  restorePaged.restore = {...restorePaged.restore, complete: structuredClone(restorePaged.restore.complete)};
  restorePaged.restore.complete[0].actors[1].paginationError = 'Search exceeded its page limit';
  assert.equal(rehearsalComplete(restorePaged), false);
  const denialPaged = one();
  denialPaged.denials = structuredClone(denialPaged.denials);
  denialPaged.denials.checks[0].paginationError = 'Search rejected a continuation';
  assert.equal(rehearsalComplete(denialPaged), false);
  const hole = one();
  delete (hole.rounds[0].latencies as unknown[])[5];
  assert.equal(hole.rounds[0].latencies.length, queries.length);
  assert.equal(rehearsalComplete(hole), false);
  const planHole = one();
  planHole.plans = [...planHole.plans];
  delete (planHole.plans as unknown[])[0];
  assert.equal(rehearsalComplete(planHole), false);
  const missing = one();
  (missing.denials.checks as unknown[])[0] = undefined;
  assert.equal(rehearsalComplete(missing), false);
});

test('the formal judge treats holes as missing evidence and keeps its verdicts for dense evidence', () => {
  assert.equal(judge(evidence()), 'PASS');
  const formalHole = evidence();
  delete (formalHole.rounds[1].latencies as unknown[])[0];
  assert.equal(judge(formalHole), 'NOT EVALUATED');
  const rowHole = evidence();
  delete (rowHole.complete[0].actors as unknown[])[0];
  assert.equal(judge(rowHole), 'NOT EVALUATED');
  const checkHole = evidence();
  delete (checkHole.denials.checks as unknown[])[0];
  assert.equal(judge(checkHole), 'NOT EVALUATED');
  const fromJson = JSON.parse(JSON.stringify(evidence()));
  assert.equal(judge(fromJson), 'PASS', 'evidence read from evidence.json is always dense');
});

test('a rehearsal stops at the first query block that is not fully sampled; the formal run keeps measuring', async () => {
  const sample = (query: string): Sample => ({query, n: 100, p50: 1, p95: 2, p99: 3,
    ...(accepts(query) ? {} : {outcomes: Array<string>(100).fill('search_query_too_short')})});
  const abortFirst = async (query: string) => query === 'ja1-frequent'
    ? {query, outcomes: [], sqlError: 'ERROR: canceling statement'} : sample(query);
  assert.equal(queries[0][0], 'ja1-frequent');
  let timed: string[] = [];
  const time = (fn: (query: string) => Promise<Sample>) => async (query: string) => { timed.push(query); return fn(query); };
  await assert.rejects(measureBlocks(queries, time(abortFirst), () => {}, true), /REHEARSAL \/ NON-EVALUATION INVALID: ja1-frequent/);
  assert.deepEqual(timed, ['ja1-frequent']);
  timed = [];
  const formal = await measureBlocks(queries, time(abortFirst), () => {}, false);
  assert.equal(formal.length, queries.length);
  assert.equal(timed.length, queries.length);
  timed = [];
  const slow = async (query: string) => ({...sample(query), p95: 5000, p99: 6000});
  assert.equal((await measureBlocks(queries, time(slow), () => {}, true)).length, queries.length);
  timed = [];
  const fewer = async (query: string) => query === queries[2][0] ? {...sample(query), n: 99} : sample(query);
  await assert.rejects(measureBlocks(queries, time(fewer), () => {}, true), /not fully sampled/);
  assert.equal(timed.length, 3);
});

test('the rehearsal handoff keeps both archives on success, as the formal run does, and deletes them on failure', async () => {
  const identity = {file: snapshotFile, systemIdentifier: '42', sha256: 'a'.repeat(64), bytes: 10} as const;
  const run = async (override: Partial<HandoffSteps> = {}, restored = '42') => {
    const calls: string[] = [];
    let started = false;
    const steps: HandoffSteps = {
      systemIdentifier: () => { calls.push('identity'); return started ? restored : '42'; },
      preserve: async id => { calls.push(`preserve ${id}`); return identity; },
      stop: () => { calls.push('stop'); },
      stage: async got => { calls.push(`stage ${got.sha256 === identity.sha256}`); return '/staged'; },
      start: async directory => { calls.push(`start ${directory}`); started = true; },
      discard: () => { calls.push('discard'); },
      ...override,
    };
    try {
      return {calls, result: await rehearsalHandoff(steps)};
    } catch (error) {
      return {calls, error};
    }
  };
  const ok = await run();
  assert.deepEqual(ok.result, identity);
  assert.deepEqual(ok.calls, ['identity', 'preserve 42', 'stop', 'stage true', 'start /staged', 'identity'],
    'the archives stay through the measured round; the worker deletes them before completing');
  const fail = (step: string) => async () => { throw new Error(`${step} failed`); };
  const verify = await run({preserve: fail('pg_verifybackup')});
  assert.match(String(verify.error), /pg_verifybackup failed/);
  assert.deepEqual(verify.calls, ['identity', 'discard']);
  const staging = await run({stage: fail('staging')});
  assert.match(String(staging.error), /staging failed/);
  assert.deepEqual(staging.calls.slice(-2), ['stop', 'discard']);
  const startup = await run({start: fail('restored startup')});
  assert.match(String(startup.error), /restored startup failed/);
  assert.equal(startup.calls.at(-1), 'discard');
  const other = await run({}, '43');
  assert.match(String(other.error), /Restored cluster identity differs/);
  assert.equal(other.calls.at(-1), 'discard');
  const both = await run({start: fail('restored startup'), discard: () => { throw new Error('unlink failed'); }});
  assert.ok(both.error instanceof AggregateError);
  assert.deepEqual(both.error.errors.map(String), ['Error: restored startup failed', 'Error: unlink failed']);
});

test('archive deletion attempts each copy on its own and reports every failure', {skip: process.getuid?.() === 0}, t => {
  const out = mkdtempSync(join(tmpdir(), 'd3r-discard-test-'));
  const staging = join(out, stagingDirectory);
  t.after(() => {
    chmodSync(out, 0o700);
    chmodSync(staging, 0o700);
    rmSync(out, {recursive: true, force: true});
  });
  mkdirSync(staging);
  writeFileSync(join(out, snapshotFile), 'original');
  writeFileSync(join(staging, snapshotFile), 'staged');
  chmodSync(out, 0o500);
  assert.throws(() => discardRehearsalSnapshot(out), error => error instanceof AggregateError && error.errors.length === 1 &&
    error.message.includes(join(out, snapshotFile)));
  assert.equal(existsSync(join(staging, snapshotFile)), false, 'the staged copy is deleted although the original failed');
  assert.equal(existsSync(join(out, snapshotFile)), true);
  writeFileSync(join(staging, snapshotFile), 'staged');
  chmodSync(staging, 0o500);
  assert.throws(() => discardRehearsalSnapshot(out), error => error instanceof AggregateError && error.errors.length === 2 &&
    error.message.includes(join(out, snapshotFile)) && error.message.includes(join(staging, snapshotFile)));
  chmodSync(out, 0o700);
  chmodSync(staging, 0o700);
  discardRehearsalSnapshot(out);
  assert.deepEqual(readdirSync(staging), []);
});

const undeletable = [
  {name: 'staged copy in a read-only directory', lock: (out: string) => chmodSync(join(out, stagingDirectory), 0o500),
    unlock: (out: string) => chmodSync(join(out, stagingDirectory), 0o700)},
  ...(process.platform === 'darwin' ? [{name: 'immutable source archive',
    lock: (out: string) => { execFileSync('chflags', ['uchg', join(out, snapshotFile)]); },
    unlock: (out: string) => { if (existsSync(join(out, snapshotFile))) execFileSync('chflags', ['nouchg', join(out, snapshotFile)]); }}] : []),
];
const archiveFixture = (prefix: string) => {
  const out = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(out, stagingDirectory));
  writeFileSync(join(out, snapshotFile), 'original');
  writeFileSync(join(out, stagingDirectory, snapshotFile), 'staged');
  return out;
};

test('a rehearsal deletes its archives before writing completed.json; a failed deletion fails the worker',
  {skip: process.getuid?.() === 0}, t => {
  const one = {...evidence(), formal: false, rounds: [evidence().rounds[0]]};
  const completion = {manifestHash: 'm', runKind: 'rehearsal'};
  const ok = archiveFixture('d3r-complete-test-');
  t.after(() => rmSync(ok, {recursive: true, force: true}));
  completeRun(ok, 'rehearsal', one, completion);
  assert.equal(existsSync(join(ok, snapshotFile)), false);
  assert.equal(existsSync(join(ok, stagingDirectory, snapshotFile)), false);
  assert.deepEqual(JSON.parse(readFileSync(join(ok, 'completed.json'), 'utf8')), completion);
  for (const {name, lock, unlock} of undeletable) {
    const out = archiveFixture('d3r-complete-test-');
    t.after(() => { unlock(out); rmSync(out, {recursive: true, force: true}); });
    lock(out);
    assert.throws(() => completeRun(out, 'rehearsal', one, completion), AggregateError, name);
    assert.equal(existsSync(join(out, 'completed.json')), false, `${name}: no completion, so the supervisor records the run invalid`);
  }
});

test('if the CLI still cannot delete a rehearsal archive, the published status never says valid or cleanupVerified',
  {skip: process.getuid?.() === 0}, t => {
  for (const {name, lock, unlock} of undeletable) {
    const out = archiveFixture('d3r-cleanup-test-');
    t.after(() => { unlock(out); rmSync(out, {recursive: true, force: true}); });
    writeFileSync(join(out, 'run-status.json'), JSON.stringify({manifestHash: 'm', valid: true, cleanupVerified: true, exitCode: 0}));
    writeFileSync(join(out, 'finished.json'), '{}');
    writeFileSync(join(out, 'summary.json'), '{}');
    lock(out);
    let clean: boolean | undefined;
    try {
      clean = cleanUpRun(out, 'rehearsal', false);
    } catch {
      // Removing the locked staging directory also fails; the status is already rewritten.
    }
    assert.notEqual(clean, true, name);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'run-status.json'), 'utf8')),
      {manifestHash: 'm', valid: false, cleanupVerified: false, exitCode: 1}, name);
    assert.equal(existsSync(join(out, 'finished.json')), false, name);
    assert.equal(existsSync(join(out, 'summary.json')), false, name);
  }
  const ok = archiveFixture('d3r-cleanup-test-');
  t.after(() => rmSync(ok, {recursive: true, force: true}));
  const status = JSON.stringify({manifestHash: 'm', valid: true, cleanupVerified: true, exitCode: 0});
  writeFileSync(join(ok, 'run-status.json'), status);
  assert.equal(cleanUpRun(ok, 'rehearsal', false), true);
  assert.deepEqual(readdirSync(ok), ['run-status.json']);
  assert.equal(readFileSync(join(ok, 'run-status.json'), 'utf8'), status);
});

test('rehearsal staging checks the extracted copy, deletes only archives and is never a formal backfill', async t => {
  const out = mkdtempSync(join(tmpdir(), 'd3r-rehearsal-stage-test-'));
  t.after(() => rmSync(out, {recursive: true, force: true}));
  const archive = join(out, snapshotFile);
  writeFileSync(archive, 'physical archive');
  const identity = await snapshotIdentity(archive);
  const staging = join(out, stagingDirectory);
  mkdirSync(staging);
  assert.equal(await stageSnapshot(archive, identity, staging), staging);
  assert.equal(readFileSync(join(staging, snapshotFile), 'utf8'), 'physical archive');
  await assert.rejects(stageSnapshot(archive, {...identity, sha256: 'b'.repeat(64)}, staging), /snapshot identity mismatch/);
  await assert.rejects(stageSnapshot(archive, {...identity, bytes: identity.bytes + 1}, staging), /snapshot identity mismatch/);
  const {sha256: manifestHash} = loadManifest();
  writeFileSync(join(out, 'rehearsal-handoff.json'), JSON.stringify({label: 'REHEARSAL / NON-EVALUATION',
    snapshot: {file: snapshotFile, systemIdentifier: '42', ...identity}}));
  writeFileSync(join(out, 'finished.json'), JSON.stringify({manifestHash, runKind: 'rehearsal'}));
  writeFileSync(join(out, 'run-status.json'), JSON.stringify({manifestHash, valid: true, cleanupVerified: true}));
  await assert.rejects(loadBackfill(out, manifestHash, 1_000_000, 1000), /ENOENT/);
  discardRehearsalSnapshot(out);
  assert.equal(existsSync(archive), false);
  assert.equal(existsSync(join(staging, snapshotFile)), false);
  assert.deepEqual(readdirSync(staging), [], 'the bind-mounted staging directory stays for docker restart');
  discardRehearsalSnapshot(out);
});

test('a worker runs only for its own supervisor launch; inherited variables never pick its mode, source or output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-worker-test-'));
  const repository = mkdtempSync(join(tmpdir(), 'd3r-worker-repo-'));
  let n = 0;
  const launched = (mode: Parameters<typeof writeLaunch>[1], from?: string) => {
    const out = join(dir, `out-${n++}`);
    mkdirSync(out);
    const {token} = writeLaunch(out, mode, from);
    return {out, env: {SEARCH_WORKER: '1', SEARCH_D3R_MODE: mode, SEARCH_D3R_OUT: out, SEARCH_D3R_LAUNCH: token,
      ...(from ? {SEARCH_D3R_FROM: from} : {})} as NodeJS.ProcessEnv};
  };
  const check = (env: NodeJS.ProcessEnv, argv: string[] = [], pid = process.pid) => workerOptions(env, argv, pid, repository);
  try {
    for (const mode of ['smoke', 'rehearsal', 'backfill-only'] as const) assert.equal(check(launched(mode).env).mode, mode);
    assert.equal(check(launched('formal', '/tmp/source').env).fromBackfill, '/tmp/source');
    const rehearsal = launched('rehearsal');
    assert.equal(JSON.parse(readFileSync(join(rehearsal.out, launchFile), 'utf8')).label, 'REHEARSAL / NON-EVALUATION');
    assert.throws(() => check(rehearsal.env, ['--rehearsal']), /CLI arguments/);
    assert.throws(() => check({...rehearsal.env, SEARCH_D3R_MODE: 'formal', SEARCH_D3R_FROM: '/tmp/formal'}), /disagree/);
    assert.throws(() => check({...rehearsal.env, SEARCH_D3R_FROM: '/tmp/formal'}), /disagree/);
    assert.throws(() => check({...rehearsal.env, SEARCH_D3R_LAUNCH: 'stale'}), /own supervisor/);
    assert.throws(() => check({...rehearsal.env, SEARCH_D3R_LAUNCH: undefined}), /own supervisor/);
    assert.throws(() => check(rehearsal.env, [], process.pid + 1), /own supervisor/);
    assert.throws(() => check({...rehearsal.env, SEARCH_D3R_OUT: undefined}), /output directory/);
    const crowded = launched('rehearsal');
    writeFileSync(join(crowded.out, 'image.json'), '{}');
    assert.throws(() => check(crowded.env), /own supervisor/);
    const unmarked = join(dir, 'unmarked');
    mkdirSync(unmarked);
    assert.throws(() => check({...rehearsal.env, SEARCH_D3R_OUT: unmarked}), /own supervisor/);
    const link = join(dir, 'link');
    symlinkSync(rehearsal.out, link);
    assert.throws(() => check({...rehearsal.env, SEARCH_D3R_OUT: link}), /own supervisor/);
    const nested = join(dir, 'formal-artifact');
    mkdirSync(nested);
    writeFileSync(join(nested, 'run-status.json'), '{}');
    const child = join(nested, 'child');
    mkdirSync(child);
    const {token} = writeLaunch(child, 'rehearsal', undefined);
    assert.throws(() => check({...rehearsal.env, SEARCH_D3R_OUT: child, SEARCH_D3R_LAUNCH: token}), /inside another run/);
    const inGit = join(repository, 'out');
    mkdirSync(inGit);
    assert.throws(() => check({...rehearsal.env, SEARCH_D3R_OUT: inGit}), /outside Git/);
    const forged = (mode: string, fromBackfill: string | null) => {
      const out = join(dir, `forged-${n++}`);
      mkdirSync(out);
      writeFileSync(join(out, launchFile), JSON.stringify({mode, label: null, fromBackfill, token: 't', supervisorPid: process.pid,
        supervisorStart: processStart(process.pid)}));
      return {SEARCH_D3R_MODE: mode, SEARCH_D3R_OUT: out, SEARCH_D3R_LAUNCH: 't', ...(fromBackfill ? {SEARCH_D3R_FROM: fromBackfill} : {})};
    };
    assert.throws(() => check(forged('cleanup', '/tmp/source')), /Invalid worker mode/);
    assert.throws(() => check(forged('rehearsal', '/tmp/formal')), /formal worker/);
    assert.throws(() => check(forged('formal', null)), /formal worker/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
    rmSync(repository, {recursive: true, force: true});
  }
});

test('a stale launch cannot be replayed: the worker claims it once and checks the supervisor start time', t => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-claim-test-'));
  const repository = mkdtempSync(join(tmpdir(), 'd3r-claim-repo-'));
  t.after(() => {
    rmSync(dir, {recursive: true, force: true});
    rmSync(repository, {recursive: true, force: true});
  });
  let n = 0;
  const launched = (startOf = processStart) => {
    const out = join(dir, `out-${n++}`);
    mkdirSync(out);
    const {token} = writeLaunch(out, 'formal', '/tmp/source', startOf);
    return {out, env: {SEARCH_WORKER: '1', SEARCH_D3R_MODE: 'formal', SEARCH_D3R_OUT: out, SEARCH_D3R_LAUNCH: token,
      SEARCH_D3R_FROM: '/tmp/source'} as NodeJS.ProcessEnv};
  };
  const first = launched();
  assert.equal(workerOptions(first.env, [], process.pid, repository).fromBackfill, '/tmp/source');
  assert.equal(JSON.parse(readFileSync(join(first.out, claimFile), 'utf8')).workerPid, process.pid);
  assert.throws(() => workerOptions(first.env, [], process.pid, repository), /own supervisor/,
    'a captured worker environment cannot start a second worker on the same launch');
  const raced = launched();
  writeFileSync(join(raced.out, claimFile), '{}', {flag: 'wx'});
  assert.throws(() => workerOptions(raced.env, [], process.pid, repository), /own supervisor/);
  const reused = launched(() => 'Sun Nov 22 01:00:00 2026');
  assert.throws(() => workerOptions(reused.env, [], process.pid, repository), /own supervisor/,
    'the same PID with another start time is a reused PID, not the supervisor');
  assert.throws(() => workerOptions(reused.env, [], process.pid, repository, () => ''), /own supervisor/);
  assert.equal(existsSync(join(reused.out, claimFile)), false);
});

test('inherited worker variables cannot turn --rehearsal into a formal worker inside a formal artifact', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-inherited-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const formal = join(dir, 'formal');
  const source = join(dir, 'backfill');
  mkdirSync(formal);
  mkdirSync(source);
  for (const file of ['image.json', 'manifest.json', 'run-status.json']) writeFileSync(join(formal, file), '{}');
  writeFileSync(join(source, receiptFile), '{}');
  const child = join(formal, 'empty');
  mkdirSync(child);
  const before = readdirSync(formal).sort();
  for (const argv of [['--rehearsal'], []]) {
    const run = spawn(process.execPath, [fileURLToPath(new URL('./d3r/run.ts', import.meta.url)), ...argv],
      {env: {...process.env, SEARCH_WORKER: '1', SEARCH_D3R_MODE: 'formal', SEARCH_D3R_FROM: source, SEARCH_D3R_OUT: child},
        stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '';
    run.stderr.on('data', data => { stderr += String(data); });
    const [code] = await once(run, 'close');
    assert.notEqual(code, 0);
    assert.match(stderr, argv.length ? /CLI arguments/ : /own supervisor/);
  }
  assert.deepEqual(readdirSync(child), []);
  assert.deepEqual(readdirSync(formal).sort(), before);
});

test('a failed rehearsal leaves its REHEARSAL launch marker and never a summary', {timeout: 20_000}, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'd3r-rehearsal-fail-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const out = join(dir, 'results');
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'docker'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'image' || args[0] === 'pull') process.exit(1);
`, {mode: 0o700});
  const run = spawn(process.execPath, [fileURLToPath(new URL('./d3r/run.ts', import.meta.url)), '--rehearsal', `--out=${out}`],
    {env: {...process.env, PATH: `${dir}:${process.env.PATH}`, SEARCH_WORKER: '', SEARCH_D3R_MODE: 'formal'},
      stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  run.stderr.on('data', data => { stderr += String(data); });
  const [code] = await once(run, 'close');
  assert.equal(code, 1, stderr);
  const launch = JSON.parse(readFileSync(join(out, launchFile), 'utf8'));
  assert.equal(launch.mode, 'rehearsal');
  assert.equal(launch.label, 'REHEARSAL / NON-EVALUATION');
  assert.equal(launch.fromBackfill, null);
  assert.equal(JSON.parse(readFileSync(join(out, 'run-status.json'), 'utf8')).valid, false);
  assert.equal(existsSync(join(out, 'summary.json')), false);
  assert.equal(existsSync(join(out, 'finished.json')), false);
  assert.ok(readFileSync(calls, 'utf8').includes('"pull"'), 'the worker started, so the launch marker admitted it');
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
    const artifact = join(dir, 'artifact');
    mkdirSync(join(artifact, 'sub'), {recursive: true});
    writeFileSync(join(artifact, 'completed.json'), '{}');
    assert.throws(() => outputPath(join(artifact, 'sub', 'next')), /inside another run/);
    assert.throws(() => outputPath(join(artifact, 'next')), /inside another run/);
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

test('a warm-up pagination abort stops a rehearsal at that query; the formal run records it and keeps warming', async () => {
  const at = '2026-01-01T00:00:00.000000Z';
  let sessions: string[] = [];
  const open = async (body: (sql: (text: string) => Promise<string>) => Promise<void>) => {
    let query = '';
    await body(async sql => {
      if (sql.startsWith('BEGIN')) {
        query = sql.includes("'開発'") ? 'b' : 'a';
        sessions.push(query);
        return [org(1), JSON.stringify([[channel(1, 0)], true]), JSON.stringify('開発 API')].join('\n');
      }
      return sql.startsWith('EXECUTE') && query === 'a' ? `${uuid(2)}|${at}\n${uuid(2)}|${at}` : '';
    });
  };
  const querySet = [['a', '開'], ['b', '開発']] as const;
  await assert.rejects(warmup(productionPath().page, querySet, 2, open, true),
    /REHEARSAL \/ NON-EVALUATION INVALID: warm-up a: Search repeated a Message/);
  assert.deepEqual(sessions, ['a']);
  sessions = [];
  assert.deepEqual(await warmup(productionPath().page, querySet, 2, open),
    [1, 2].map(sweep => ({sweep, query: 'a', paginationError: 'Search repeated a Message or moved its cursor backwards'})));
  assert.deepEqual(sessions, ['a', 'b', 'a', 'b']);
});

test('a stopped rehearsal still writes its warm-up records, including the failing one', async t => {
  const at = '2026-01-01T00:00:00.000000Z';
  const open = async (body: (sql: (text: string) => Promise<string>) => Promise<void>) => {
    let query = '';
    await body(async sql => {
      if (sql.startsWith('BEGIN')) {
        query = sql.includes("'開発'") ? 'b' : 'a';
        return [org(1), JSON.stringify([[channel(1, 0)], true]), JSON.stringify('開発 API')].join('\n');
      }
      return sql.startsWith('EXECUTE') && query === 'b' ? `${uuid(2)}|${at}\n${uuid(2)}|${at}` : '';
    });
  };
  const dir = mkdtempSync(join(tmpdir(), 'd3r-warmup-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const querySet = [['a', '開'], ['b', '開発']] as const;
  const stopped = join(dir, 'stopped.json');
  await assert.rejects(recordedWarmup(stopped, productionPath().page, querySet, 2, open, true), /INVALID: warm-up b/);
  assert.deepEqual(JSON.parse(readFileSync(stopped, 'utf8')),
    [{sweep: 1, query: 'b', paginationError: 'Search repeated a Message or moved its cursor backwards'}]);
  const formal = join(dir, 'formal.json');
  const errors = await recordedWarmup(formal, productionPath().page, querySet, 2, open, false);
  assert.equal(errors.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(formal, 'utf8')), errors);
});

const GB = 1e9;
// Injected probe readings, one per sample: [docker free, docker used, output free, output used] in GB.
const headroomRun = (readings: (readonly number[] | Error)[]) => {
  const {frozen} = loadManifest();
  const formalRounds = frozen.performance.rounds, rehearsalRounds = frozen.rehearsal.performance.rounds;
  const dir = mkdtempSync(join(tmpdir(), 'd3r-headroom-test-'));
  const saved = new Map<string, unknown>();
  const save = (path: string, value: unknown) => { saved.set(path, JSON.parse(JSON.stringify(value))); };
  let i = 0, current: readonly number[] | Error = [];
  const disk = (offset: number): Disk => {
    if (current instanceof Error) throw current;
    return {free: current[offset] * GB, used: current[offset + 1] * GB};
  };
  let error: unknown;
  try {
    const sampler = headroomSampler(true, {docker: () => { current = readings[i++]; return disk(0); }, output: () => disk(2)},
      samples => assertHeadroom(dir, samples, formalRounds, rehearsalRounds, save));
    for (const [n] of readings.entries()) sampler.sample(`sample ${n}`);
    assertHeadroom(dir, sampler.samples, formalRounds, rehearsalRounds, save);
  } catch (caught) {
    error = caught;
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
  return {error, formalRounds, rehearsalRounds,
    report: saved.get(join(dir, 'rehearsal-headroom.json')) as ReturnType<typeof projectHeadroom> | undefined};
};

test('rehearsal headroom projects the measured round onto the formal rounds from the manifest and passes with space', () => {
  const {error, report, formalRounds, rehearsalRounds} = headroomRun([[100, 50, 40, 10], [80, 70, 35, 12], [95, 55, 36, 14]]);
  assert.equal(error, undefined);
  assert.ok(formalRounds > rehearsalRounds);
  assert.equal(report?.label, 'REHEARSAL / NON-EVALUATION');
  assert.equal(report?.ok, true);
  assert.deepEqual(report?.projection?.docker, {start: {free: 100 * GB, used: 50 * GB}, end: {free: 95 * GB, used: 55 * GB},
    minFree: 80 * GB, roundGrowth: 5 * GB, required: (formalRounds - rehearsalRounds) * 5 * GB,
    margin: 80 * GB - (formalRounds - rehearsalRounds) * 5 * GB, ok: true});
  assert.equal(report?.projection?.output.roundGrowth, 4 * GB);
  assert.equal(report?.projection?.output.minFree, 35 * GB);
  const shrinking = headroomRun([[10, 50, 10, 10], [10, 40, 10, 5]]);
  assert.equal(shrinking.error, undefined, 'growth is clamped at zero');
  assert.equal(shrinking.report?.projection?.docker.required, 0);
});

test('rehearsal headroom fails when the projection is negative on the Docker disk or the output filesystem alone', () => {
  for (const [fs, readings] of [
    ['docker', [[100, 50, 400, 10], [20, 130, 390, 12], [30, 120, 395, 14]]],
    ['output', [[400, 50, 100, 10], [390, 60, 20, 90], [395, 55, 30, 80]]],
  ] as const) {
    const {error, report} = headroomRun(readings as unknown as number[][]);
    assert.match(String(error), new RegExp(`REHEARSAL / NON-EVALUATION INVALID: disk headroom.*${fs} margin -`), fs);
    assert.equal(report?.ok, false, fs);
    assert.equal(report?.projection?.[fs].ok, false, fs);
    assert.equal(report?.projection?.[fs === 'docker' ? 'output' : 'docker'].ok, true, fs);
  }
});

test('rehearsal headroom fails at once when a measurement fails and when one is missing', () => {
  const failed = headroomRun([[100, 50, 40, 10], new Error('Docker disk probe failed'), [95, 55, 36, 14]]);
  assert.match(String(failed.error), /INVALID: disk headroom.*sample 1: Error: Docker disk probe failed/);
  assert.equal(failed.report?.samples.length, 2, 'stops at the failed sample');
  assert.equal(failed.report?.projection, undefined);
  const nan = headroomRun([[100, 50, 40, 10], [80, Number.NaN, 35, 12]]);
  assert.match(String(nan.error), /sample 1: docker measurement missing/);
  const one = headroomRun([[100, 50, 40, 10]]);
  assert.match(String(one.error), /fewer than a start and an end sample/);
  const {frozen} = loadManifest();
  const partial = projectHeadroom([{at: 'start', docker: {free: GB, used: GB}, output: {free: GB, used: GB}},
    {at: 'end', docker: {free: GB, used: GB}}], frozen.performance.rounds, frozen.rehearsal.performance.rounds);
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.problems, ['end: output measurement missing']);
});

test('headroom is never probed outside a rehearsal and measures both filesystems the documented way', () => {
  let probes = 0;
  const sampler = headroomSampler(false, {docker: () => { probes++; return {free: 0, used: 0}; },
    output: () => { probes++; return {free: 0, used: 0}; }}, () => assert.fail('no failure outside a rehearsal'));
  sampler.sample('round 1 start');
  sampler.sample('round 1 end');
  assert.equal(probes, 0);
  assert.deepEqual(sampler.samples, []);
  assert.deepEqual(dfBytes('Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 1000 300 700 30% /\n'),
    {free: 700 * 1024, used: 300 * 1024});
  assert.throws(() => dfBytes('garbage'), /Unreadable df output/);
  assert.deepEqual(dockerDiskArgs('sha256:x', 'label=1'), ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--label', 'label=1', '--entrypoint', 'df', 'sha256:x', '-Pk', '/']);
  const disk = outputDisk(tmpdir());
  assert.ok(Number.isSafeInteger(disk.free) && disk.free > 0 && Number.isSafeInteger(disk.used) && disk.used > 0);
});

test('a rehearsal stops at a restore drill or denial check that recorded a pagination error', () => {
  const e = evidence();
  stopUnlessWhole('restore drill', e.restore);
  stopUnlessWhole('denial checks', e.denials);
  const restore = evidence().restore;
  restore.complete[3].actors[1].paginationError = 'Search repeated a Message or moved its cursor backwards';
  assert.throws(() => stopUnlessWhole('restore drill', restore), /REHEARSAL \/ NON-EVALUATION INVALID: restore drill/);
  const checks = evidence().denials;
  checks.checks[2].paginationError = 'Search rejected a continuation';
  assert.throws(() => stopUnlessWhole('denial checks', checks), /denial checks recorded an error/);
  delete (checks.checks as unknown[])[2];
  assert.throws(() => stopUnlessWhole('denial checks', checks), /denial checks/);
  const source = readFileSync(new URL('./d3r/run.ts', import.meta.url), 'utf8');
  const worker = source.slice(source.indexOf('const restore = await restoreDrill'), source.indexOf('const {querySet} = conditions'));
  assert.match(worker, /restoreDrill\(records\.small\.termRows\);\n\s*if \(mode === 'rehearsal'\) stopUnlessWhole\('restore drill', restore\);/);
  assert.match(worker, /\}\);\n\s*if \(mode === 'rehearsal'\) stopUnlessWhole\('denial checks', accessChecks\);/);
});

test('the formal judge treats a hole in short-query outcomes as missing, as after a JSON round trip', () => {
  const short = evidence();
  const i = queries.findIndex(([id]) => !accepts(id));
  const sample = short.rounds[0].latencies[i];
  assert.ok(sample.outcomes);
  delete (sample.outcomes as unknown[])[50];
  assert.equal(sample.outcomes.length, 100);
  assert.equal(judge(short), 'NOT EVALUATED');
  assert.equal(judge(JSON.parse(JSON.stringify(short))), 'NOT EVALUATED');
  assert.equal(judge(evidence()), 'PASS');
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
