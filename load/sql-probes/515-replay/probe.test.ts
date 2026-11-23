import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stages } from '../../harness-core/stages.ts';
import { replayPosition } from '../../slice5/config.ts';
import { describePlan, pgbenchScript, pgbenchTimings, position, quantiles, sections, timings } from './measure.ts';
import { execute, expand, literal, pgbenchExecute, prepare, type Bindings, type Statement } from './sql.ts';

const page: Statement = { name: 'page', sql: 'SELECT $1 WHERE $2 > 0', refs: 'example.rs:1',
  parameters: ['organization', 'after'], rows: 1 };

test('reads Rust cooked and raw SQL, expanding positional and named arguments', () => {
  assert.equal(literal('format!("SELECT \\"name\\" \\\n    FROM {table}")'), 'SELECT "name" FROM {table}');
  assert.equal(literal('r#"SELECT \'YYYY-MM-DD"T"\'\nFROM messages"#'), 'SELECT \'YYYY-MM-DD"T"\'\nFROM messages');
  assert.equal(expand('WITH x AS ({}) SELECT {column}, {} FROM x', { 0: 'SELECT 1', column: '$1', 1: '$2' }),
    'WITH x AS (SELECT 1) SELECT $1, $2 FROM x');
  assert.throws(() => expand('{missing}', {}), /Missing SQL template argument/);
  assert.throws(() => literal('not a string'), /Missing Rust SQL literal/);
});

test('renders positional PostgreSQL parameters, quoting and transaction commands', () => {
  const bindings: Bindings = { organization: "org'1", organizationText: "org'1", token: '\\x00', member: 'm',
    revision: 0, channel: 'c', after: 42, through: 90, limit: 51 };
  assert.equal(prepare(page), 'PREPARE page(uuid,bigint) AS SELECT $1 WHERE $2 > 0;');
  assert.equal(execute(page, bindings), "EXECUTE page('org''1',42)");
  assert.equal(pgbenchExecute(page), 'EXECUTE page(:organization,:after);');
  const begin = { name: 'begin', sql: 'BEGIN', refs: 'example.rs:1' };
  assert.equal(prepare(begin), '');
  assert.equal(execute(begin, bindings), 'BEGIN');
  assert.equal(pgbenchExecute(begin), 'BEGIN;');
});

test('positions use all four Part C reader coordinates and skip their warmup iterations', () => {
  for (const depth of ['recent', 'deep']) {
    const cell = { name: '1M-' + depth, size: 1_000_000, depth };
    assert.equal(position(cell, 0), replayPosition(cell.size, 1000, 50, depth, 0, 10));
    assert.equal(position(cell, 3), replayPosition(cell.size, 1000, 50, depth, 3, 10));
    assert.equal(position(cell, 4), replayPosition(cell.size, 1000, 50, depth, 0, 11));
    const script = pgbenchScript([page], cell, 510);
    assert.match(script, /\\set i 550 \+ :client_sample/);
    assert.match(script, depth === 'recent' ? /999000 \+ \(:spin % 950\)/ : /0 \+ \(:spin % 500000\)/);
  }
});

test('parses complete independent timing observations and rejects malformed data', () => {
  const output = 'Timing is on.\n@sample-3\nTime: 0.125 ms\nTime: 0.250 ms\n@prepared\n[]';
  assert.deepEqual(timings(output, ['begin', 'page'], 3, 1), {
    samples: [{ index: 3, roundTripSumMs: 0.375, statementsMs: { begin: 0.125, page: 0.250 } }],
    prepared: [],
  });
  assert.throws(() => timings(output, ['begin'], 3, 1), /one psql timing per SQL statement/);
  assert.throws(() => sections('@page\n{}\n@page\n{}'), /duplicate output marker/);
  assert.deepEqual(pgbenchTimings('0 1 375 0 1 2\n0 2 500 0 1 3', 2), [0.375, 0.5]);
  assert.throws(() => pgbenchTimings('0 1 failed 0 1 2', 1), /Invalid pgbench/);
  assert.throws(() => pgbenchTimings('0 1 375 0 1 2', 2), /Incomplete pgbench/);
  assert.deepEqual(quantiles([9, 2, 4, 3]), { n: 4, p50: 3, p95: 9 });
  assert.throws(() => quantiles([Infinity]), /Invalid latency/);
});

test('plan summary retains root buffer totals, index bounds and child loops', () => {
  const plan = [{
    Plan: { 'Node Type': 'Nested Loop', 'Actual Rows': 51, 'Actual Loops': 1, 'Shared Hit Blocks': 80,
      Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'messages_pkey', 'Index Cond': '(id = l.message_id)',
        'Actual Rows': 1, 'Actual Loops': 51, 'Shared Read Blocks': 5, 'Temp Written Blocks': 2 }] },
    Planning: { 'Shared Hit Blocks': 50 }, 'Planning Time': 0.5, 'Execution Time': 0.75,
  }];
  const result = describePlan(plan, 51);
  assert.equal(result.executionBuffers.sharedHit, 80);
  assert.equal(result.planningBuffers.sharedHit, 50);
  assert.equal(result.planningMs, 0.5);
  assert.equal(result.executionMs, 0.75);
  const [scan] = (result.shape as { children: Record<string, unknown>[] }).children;
  assert.equal(scan.indexCond, '(id = l.message_id)');
  assert.equal(scan.actualRows, 1);
  assert.equal(scan.loops, 51);
  assert.equal(scan.sharedRead, 5);
  assert.equal(scan.tempWritten, 2);
  assert.throws(() => describePlan(plan, 50), /Unexpected rows/);
});

test('non-finite or negative latency samples fail the summary, and status.json is still recorded', () => {
  for (const bad of [[Number.NaN], [-1], [Number.POSITIVE_INFINITY], []]) {
    const out = mkdtempSync(join(tmpdir(), 'fk515d-'));
    const run = stages(out, 'recorded');
    run.startSampling();
    const status = run.finish(() => { quantiles(bad); }, { failed: false, interrupted: false });
    assert.equal(status.summaryFailed, true);
    assert.equal(JSON.parse(readFileSync(join(out, 'status.json'), 'utf8')).outcome, 'result-failure');
  }
});
