import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLog } from './channel-log.ts';
import { checkMessageBatch, checkOrganization, dbBatchClock, messageBatchBaselineMs, seed, seedBatchLimit } from './dms-formal-seed.ts';
import { batchServerStatements, seedRehearsal } from './dms-formal-seed-diagnostic.ts';
import { seedMessagesPerOrganization, seedOrganizations, seedSizeEnv } from './dms-formal-host.ts';
import { batchSummaryFailures, seedBatchSummary, seedShape } from './dms-formal-seed-samplers.ts';

test('Message batch baseline excludes the first batch and uses the median', () => {
  assert.equal(messageBatchBaselineMs([50_000]), undefined);
  assert.equal(messageBatchBaselineMs([50_000, 2_000, 4_000]), 3_000);
  const times = [50_000, 4_000, 1_000, 2_000];
  assert.equal(messageBatchBaselineMs(times), 2_000);
  assert.deepEqual(times, [50_000, 4_000, 1_000, 2_000]);
});

test('Message batch guard skips Organization 0, first batches, missing baselines and sub-5 s batches', () => {
  checkMessageBatch(0, 1, 60_000, 2_000);
  checkMessageBatch(1, 0, 60_000, 2_000);
  checkMessageBatch(1, 1, 60_000, undefined);
  checkMessageBatch(1, 1, 4_999, 1_000);
  checkMessageBatch(1, 1, 6_000, 2_000);
  assert.throws(() => checkMessageBatch(1, 1, 5_000, 1_000), /Organization 1 Message batch 1 took 5000 ms \(limit 3000 ms\)/);
  assert.throws(() => checkMessageBatch(2, 7, 6_001, 2_000), /Organization 2 Message batch 7 took 6001 ms \(limit 6000 ms\)/);
});

test('Organization guard uses a strict 2x total-time limit', () => {
  checkOrganization(0, 199, 25_000, undefined);
  checkOrganization(1, 199, 50_000, 25_000);
  assert.throws(() => checkOrganization(2, 199, 50_001, 25_000), /Organization 2 total through Message batch 199 and final setup took 50001 ms \(limit 50000 ms\)/);
});

const originPsql = ['exec','-i','stub','psql','-X','-U','fukulow','-d','fukulow','-v','ON_ERROR_STOP=1'];
// The origin/main Message batch: one INSERT ... SELECT, then the channel log statements, nothing else.
function assertOriginBatch(input: string) {
  const match = /^INSERT INTO messages\(organization_id,id,channel_id,seq,sender,client_message_id,body\) SELECT '([0-9a-f-]{36})',gen_random_uuid\(\),c\.id,n,CASE WHEN n%2=0 THEN c\.lower_member_id ELSE c\.higher_member_id END,gen_random_uuid\(\),repeat\('x',1024\) FROM channels c CROSS JOIN generate_series\(1,100\) n WHERE c\.organization_id='\1' AND c\.id=ANY\(ARRAY\[((?:'[0-9a-f-]{36}'::uuid,?)+)\]\);\n([\s\S]*)$/.exec(input);
  assert.ok(match, 'formal batch SQL differs from origin/main');
  const ids = [...match[2]!.matchAll(/'([0-9a-f-]{36})'::uuid/g)].map(id => id[1]!);
  assert.equal(match[3], createLog(match[1]!, ids));
  assert.doesNotMatch(input, /clock_timestamp/);
}

for (const [scenario, diagnostic] of [
  ['healthy', false], ['slow batch', false], ['slow Organization', false], ['healthy', true],
  ['slow batch', true], ['slow Organization', true], ['SQL failure', true],
] as const) test(`${diagnostic ? 'diagnostic' : 'formal'} seed records timing and handles ${scenario}`, t => {
  const output = mkdtempSync(join(tmpdir(), 'dm-formal-seed-test-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const log = t.mock.method(console, 'log', () => {});
  const config = {
    DM_FORMAL_SEED: '1', DM_FORMAL_OUT: output, DM_DB_CONTAINER: 'stub',
    DM_FORMAL_SEED_ORGS: '3', DM_FORMAL_SCENARIO: 'main', DM_FORMAL_SMOKE: '0',
  };
  for (const [key, value] of Object.entries(config)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }

  let now = 0, organizationIndex = -1, batchIndex = 0;
  t.mock.method(performance, 'now', () => now);
  const epoch = 1760000000000;
  t.mock.method(Date, 'now', () => epoch + now);
  const events: string[] = [];
  const docker = t.mock.method(childProcess, 'execFileSync', (program: string, args: string[], { input: raw, stdio }: { input: string; stdio: string[] }) => {
    assert.equal(program, 'docker');
    // Diagnostic Message batches set log_duration for their own session and run between two server clock rows in the same psql call.
    const timed = raw.startsWith("SET log_duration = on;\nSELECT 'db-start', round(extract(epoch FROM clock_timestamp()) * 1000, 3), pg_backend_pid();\n");
    assert.equal(timed, diagnostic && raw.includes('INSERT INTO messages(') && !raw.includes("'seed'"));
    if (timed) {
      assert.deepEqual(args, [...originPsql, '-q', '-A', '-t']);
      assert.ok(raw.endsWith("\nSELECT 'db-end', round(extract(epoch FROM clock_timestamp()) * 1000, 3);"));
      // Every statement of the batch session logs one duration line; the DB log join expects exactly these.
      assert.equal(raw.match(/;\s*(?=\n|$)/g)?.length, batchServerStatements.max);
    } else {
      // Formal (and every non-batch) call is the origin/main command: same psql arguments, stdout ignored, same SQL.
      assert.deepEqual([args, stdio], [originPsql, ['pipe', 'ignore', 'inherit']]);
      if (raw.startsWith('INSERT INTO messages(') && !raw.includes("'seed'")) assertOriginBatch(raw);
    }
    const input = timed ? raw.split('\n').slice(2, -1).join('\n') : raw;
    const before = now;
    if (input.startsWith('INSERT INTO organizations(')) {
      organizationIndex++;
      batchIndex = 0;
    }
    if (input.startsWith('INSERT INTO messages(')) {
      now += batchIndex === 0 ? 20_000 : scenario === 'slow batch' && organizationIndex === 1 && batchIndex === 1 ? 6_001 : 2_000;
      if (scenario === 'SQL failure' && organizationIndex === 1 && batchIndex === 1) {
        throw new Error('INSERT INTO account_sessions private-token');
      }
      batchIndex++;
    } else if (scenario === 'slow Organization' && organizationIndex === 1 && input.startsWith('INSERT INTO channel_message_sequences VALUES')) {
      now += 500_000;
    } else {
      now++;
    }
    for (const statement of input.matchAll(/INSERT INTO organizations\(|INSERT INTO messages\(|EXECUTE fixture_create_log\(|ANALYZE messages, channel_log;/g)) {
      events.push(statement[0]);
    }
    if (input === 'VACUUM(ANALYZE);') events.push(input);
    // The DB side takes all but 5 ms of the batch. Formal calls ignore stdout, as on origin/main.
    return timed ? Buffer.from(`db-start|${epoch + before}.000|4242\nINSERT 0 1\ndb-end|${epoch + now - 5}.500\n`) : undefined;
  });
  syncBuiltinESMExports();
  try {
    if (scenario === 'slow batch') assert.throws(() => seed(diagnostic), /Organization 1 Message batch 1 took 6001 ms \(limit 6000 ms\)/);
    else if (scenario === 'slow Organization') assert.throws(() => seed(diagnostic), /Organization 1 total through Message batch 199 .* took \d+ ms \(limit \d+ ms\)/);
    else if (scenario === 'SQL failure') assert.throws(() => seed(diagnostic), /private-token/);
    else seed(diagnostic);
  } finally {
    docker.mock.restore();
    syncBuiltinESMExports();
  }

  const batch = ['INSERT INTO messages(', 'EXECUTE fixture_create_log('];
  const organization = [
    'INSERT INTO organizations(', ...batch, 'ANALYZE messages, channel_log;',
    ...Array.from({ length: 200 }, () => batch).flat(),
  ];
  const expected = scenario === 'healthy' ? [...organization, ...organization, ...organization, 'VACUUM(ANALYZE);']
    : [...organization, ...(scenario === 'slow batch' ? organization.slice(0, 6) : scenario === 'SQL failure' ? organization.slice(0, 4) : organization)];
  assert.deepEqual(events, expected);

  const path = join(output, 'seed-timing.jsonl');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const rows = readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  const totals = rows.filter(row => row.kind === 'organization');
  const completed = scenario === 'healthy' ? 3 : scenario === 'slow batch' || scenario === 'SQL failure' ? 1 : 2;
  assert.deepEqual(totals.map(row => row.organization), Array.from({length: completed}, (_, i) => i));
  assert.equal(log.mock.callCount(), completed);
  assert.equal(rows.length, completed * 201 + (scenario === 'slow batch' ? 2 : scenario === 'SQL failure' ? 1 : 0));
  // The seed writes exactly the rows the batch summary requires, in the shape of its arm.
  // The formal seed writes no seed-stop.json: the runner records any failure as seed-failure.
  const stop = scenario === 'healthy' ? undefined : diagnostic ? JSON.parse(readFileSync(join(output, 'seed-stop.json'), 'utf8')) : { rule: 'seed-failure' };
  const timing = seedBatchSummary(readFileSync(path, 'utf8'), undefined, { shape: seedShape('main', 3), stop, arm: diagnostic ? 'instrumented' : 'baseline' });
  assert.deepEqual([timing.malformedLines, timing.missingRows, timing.unexpectedRows, timing.expectedRows], [0, 0, 0, rows.length]);
  if (!diagnostic) assert.deepEqual(batchSummaryFailures(timing), []);
  if (diagnostic && scenario === 'healthy') {
    assert.equal(timing.dbClockMissing, 0);
    return;
  }
  if (diagnostic) {
    const raw = readFileSync(join(output, 'seed-stop.json'), 'utf8');
    assert.doesNotMatch(raw, /private-token|INSERT INTO/);
    const stop = JSON.parse(raw);
    const last = rows.at(-1);
    const baselineMs = scenario === 'slow Organization' ? totals[0].durationMs : 2_000;
    assert.deepEqual(stop, {
      organization: 1, batchIndex: scenario === 'slow Organization' ? 199 : 1,
      durationMs: scenario === 'SQL failure' ? 2_000 : last.durationMs, baselineMs,
      rule: scenario === 'slow Organization' ? 'organization-total' : scenario === 'SQL failure' ? 'seed-failure' : 'message-batch',
      limitMs: scenario === 'slow Organization' ? baselineMs * 2 : scenario === 'slow batch' ? 6_000 : null,
      startedAtMs: scenario === 'SQL failure' ? last.endedAtMs + 1 : last.startedAtMs,
      endedAtMs: scenario === 'SQL failure' ? last.endedAtMs + 2_001 : last.endedAtMs,
    });
    assert.ok(rows[0].startedAtMs >= epoch);
    assert.equal(rows[0].endedAtMs - rows[0].startedAtMs, rows[0].durationMs);
    const batch = rows.find(row => row.kind === 'batch' && row.batchIndex === 1);
    assert.deepEqual([batch.dbClockStartMs, batch.dbClockSpanMs, batch.dbBackendPid, batch.recorderMs], [batch.startedAtMs, batch.durationMs - 4.5, 4242, 0]);
    return;
  }
  // Formal rows keep the origin/main fields exactly.
  assert.deepEqual(rows[0], { kind: 'batch', organization: 0, batchIndex: 0, durationMs: 20_000 });
  if (scenario === 'slow batch') {
    assert.deepEqual(rows.at(-1), { kind: 'batch', organization: 1, batchIndex: 1, durationMs: 6_001 });
  } else if (scenario === 'slow Organization') {
    assert.ok(totals[1].durationMs > 2 * totals[0].durationMs);
    assert.deepEqual(rows.at(-1), totals[1]);
  }
});

test('DB batch clock reads only the two clock rows and marks anything else missing', () => {
  assert.deepEqual(dbBatchClock('db-start|1000.250|77\nINSERT 0 1\ndb-end|1840.750\n'), { dbClockStartMs: 1000.25, dbClockEndMs: 1840.75, dbClockSpanMs: 840.5, dbBackendPid: 77 });
  for (const stdout of [undefined, null, '', 'db-start|1000|7\n', 'db-start|2000|7\ndb-end|1000\n', 'db-start|x|7\ndb-end|1\n', 'db-start|1000\ndb-end|1001\n']) {
    assert.deepEqual(dbBatchClock(stdout), { dbClock: 'missing' });
  }
});

test('the seed sizes: full-size, smoke and pilot keep their current values; the rehearsal is one Organization of five batches', () => {
  // Pinned from the host worker at a17fc978 (the seed diagnostic arms are formal, not pilot).
  const formal = { mode: 'formal' as const }, smoke = { mode: 'smoke' as const }, pilot = { mode: 'formal' as const, pilot: true };
  assert.deepEqual([formal, smoke, pilot].map(s => [seedOrganizations(s), seedMessagesPerOrganization(s), seedSizeEnv(s)]), [
    [10, 5_000_000, { DM_FORMAL_SMOKE: '0', DM_FORMAL_SEED_ORGS: '' }],
    [1, 50_000, { DM_FORMAL_SMOKE: '1', DM_FORMAL_SEED_ORGS: '' }],
    [10, 50_000, { DM_FORMAL_SMOKE: '1', DM_FORMAL_SEED_ORGS: '10' }],
  ]);
  assert.deepEqual(seedShape('main'), { organizations: 10, batchesPerOrganization: 200 });
  const rehearsal = { ...formal, seedRehearsal: true };
  assert.deepEqual(seedRehearsal, { organizations: 1, batchesPerOrganization: 5 });
  assert.deepEqual([seedOrganizations(rehearsal), seedMessagesPerOrganization(rehearsal), seedSizeEnv(rehearsal)],
    [1, 125_000, { DM_FORMAL_SMOKE: '0', DM_FORMAL_SEED_ORGS: '1', DM_FORMAL_SEED_BATCHES: '5' }]);
  assert.equal(seedBatchLimit(undefined, 50_000), 200);
  assert.equal(seedBatchLimit('', 50_000), 200);
  assert.equal(seedBatchLimit('5', 50_000), 5);
  for (const value of ['0', '201', '-1', '1.5', ' 5', 'x']) assert.throws(() => seedBatchLimit(value, 50_000), /DM_FORMAL_SEED_BATCHES/);
});

for (const diagnostic of [false, true]) test(`${diagnostic ? 'diagnostic' : 'formal'} rehearsal seed writes one Organization of five Message batches and every timing row`, t => {
  const output = mkdtempSync(join(tmpdir(), 'dm-formal-seed-test-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const config = { DM_FORMAL_SEED: '1', DM_FORMAL_OUT: output, DM_DB_CONTAINER: 'stub', DM_FORMAL_SCENARIO: 'main', ...seedSizeEnv({ mode: 'formal', seedRehearsal: true }) };
  for (const [key, value] of Object.entries(config)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const events: string[] = [];
  const docker = t.mock.method(childProcess, 'execFileSync', (_program: string, _args: string[], { input }: { input: string }) => {
    now += 1_000;
    const batch = input.includes('INSERT INTO messages(') && !input.includes("'seed'");
    if (batch || input.startsWith('INSERT INTO organizations(') || input === 'VACUUM(ANALYZE);') events.push(batch ? 'batch' : input.slice(0, 25));
    return diagnostic && batch ? Buffer.from(`db-start|${now}.000|42\ndb-end|${now + 500}.000\n`) : undefined;
  });
  syncBuiltinESMExports();
  try { seed(diagnostic); } finally { docker.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(events, ['INSERT INTO organizations', ...Array.from({ length: 5 }, () => 'batch'), 'VACUUM(ANALYZE);']);
  const timing = seedBatchSummary(readFileSync(join(output, 'seed-timing.jsonl'), 'utf8'), undefined, { shape: seedRehearsal, arm: diagnostic ? 'instrumented' : 'baseline' });
  assert.deepEqual([timing.batches, timing.expectedRows, timing.missingRows, timing.unexpectedRows, timing.malformedLines], [5, 6, 0, 0, 0]);
  assert.equal(JSON.parse(readFileSync(join(output, 'org-0.json'), 'utf8')).fixture.messages, 125_000);
});
