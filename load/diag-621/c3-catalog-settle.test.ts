import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogVacuumSQL, databasesSQL, idleConfirmed, settleCatalogs } from './c3-catalog-settle.ts';
import type { Workers } from './c3-fixture.ts';

const sample = (workers: number, vacuums = 0, wallMs = 0): Workers => ({ wallMs, workers, vacuums });

test('autovacuum counts as finished only after three consecutive idle samples', () => {
  assert.equal(idleConfirmed([]), false);
  assert.equal(idleConfirmed([sample(0), sample(0)]), false);
  assert.equal(idleConfirmed([sample(1), sample(0), sample(0), sample(0)]), true);
  assert.equal(idleConfirmed([sample(0), sample(0), sample(1)]), false);
  assert.equal(idleConfirmed([sample(0), sample(0, 1), sample(0)]), false, 'a manual or wraparound vacuum in progress');
});

test('catalog vacuum lists only system catalog tables in one statement', () => {
  assert.match(catalogVacuumSQL, /nspname IN \('pg_catalog', 'information_schema'\)/);
  assert.match(catalogVacuumSQL, /relkind = 'r'/);
  assert.doesNotMatch(catalogVacuumSQL, /public/);
  assert.match(databasesSQL, /WHERE datallowconn/);
});

function fakeCluster(workerSamples: number[]) {
  const calls: { db: string; query: string }[] = [];
  let polls = 0;
  const sql = (db: string, query: string) => {
    calls.push({ db, query });
    if (query === databasesSQL) return JSON.stringify(['diag_1', 'postgres', 'seed_base', 'template1']);
    if (query === catalogVacuumSQL) return 'VACUUM (ANALYZE) pg_catalog.pg_class, pg_catalog.pg_shdepend, pg_catalog.pg_statistic';
    if (query.startsWith('VACUUM')) return '';
    return JSON.stringify(sample(workerSamples[Math.min(polls, workerSamples.length - 1)], 0, polls++));
  };
  return { sql, calls, polls: () => polls };
}

test('every connectable database gets its catalogs vacuumed, then the run waits for autovacuum to finish', async () => {
  const cluster = fakeCluster([1, 1, 0, 0, 0]);
  const evidence = await settleCatalogs('C3-r1-hot-17-base', cluster.sql, { intervalMs: 0 });
  assert.equal(evidence.stage, 'C3-r1-hot-17-base');
  assert.deepEqual(evidence.vacuums.map(row => [row.database, row.relations]),
    [['diag_1', 3], ['postgres', 3], ['seed_base', 3], ['template1', 3]]);
  const vacuums = cluster.calls.filter(call => call.query.startsWith('VACUUM'));
  assert.deepEqual(vacuums.map(call => call.db), ['diag_1', 'postgres', 'seed_base', 'template1']);
  assert.ok(vacuums.every(call => call.query.endsWith('pg_catalog.pg_statistic;')));
  assert.deepEqual(evidence.idle.map(row => row.workers), [1, 1, 0, 0, 0]);
  const lastVacuum = cluster.calls.findLastIndex(call => call.query.startsWith('VACUUM'));
  assert.ok(cluster.calls.slice(lastVacuum + 1).every(call => call.db === 'postgres'), 'idle is confirmed after the last vacuum');
});

test('a settle that never sees autovacuum finish fails the setup instead of measuring', async () => {
  const cluster = fakeCluster([1]);
  await assert.rejects(settleCatalogs('after seed', cluster.sql, { capMs: 20, intervalMs: 1 }), /autovacuum still running after .* \(after seed\)/);
});

test('a malformed database or catalog list fails the setup', async () => {
  await assert.rejects(settleCatalogs('s', () => 'null'), /database list malformed/);
  await assert.rejects(settleCatalogs('s', (_db, query) => query === databasesSQL ? '["postgres"]' : ''), /no catalogs listed in postgres/);
});
