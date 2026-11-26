import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogRelations, catalogRelationsSQL, databasesSQL, idleConfirmed, settleCatalogs, settleRecorder,
  statisticVacuumSQL, type CatalogSettle } from './c3-catalog-settle.ts';
import type { Workers } from './c3-fixture.ts';

const sample = (workers: number, vacuums = 0, wallMs = 0): Workers => ({ wallMs, workers, vacuums });
// The order PostgreSQL 18.6 returns: information_schema sorts before pg_catalog.
const listed = ['information_schema.sql_features', 'information_schema.sql_sizing', 'pg_catalog.pg_class',
  'pg_catalog.pg_shdepend', 'pg_catalog.pg_statistic'];
const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

test('autovacuum counts as finished only after three consecutive idle samples', () => {
  assert.equal(idleConfirmed([]), false);
  assert.equal(idleConfirmed([sample(0), sample(0)]), false);
  assert.equal(idleConfirmed([sample(1), sample(0), sample(0), sample(0)]), true);
  assert.equal(idleConfirmed([sample(0), sample(0), sample(1)]), false);
  assert.equal(idleConfirmed([sample(0), sample(0, 1), sample(0)]), false, 'a manual or wraparound vacuum in progress');
});

test('the catalog list covers only system catalog tables and is checked per relation, whatever its order', () => {
  assert.match(catalogRelationsSQL, /nspname IN \('pg_catalog', 'information_schema'\)/);
  assert.match(catalogRelationsSQL, /relkind = 'r'/);
  assert.doesNotMatch(catalogRelationsSQL, /public/);
  assert.match(databasesSQL, /WHERE datallowconn/);
  assert.deepEqual(catalogRelations('d', listed), listed);
  assert.deepEqual(catalogRelations('d', [...listed].reverse()), [...listed].reverse());
  for (const bad of [null, [], [...listed, 'public.messages'], [...listed, 'pg_catalog.x; DROP TABLE y'], [...listed, 7]]) {
    assert.throws(() => catalogRelations('d', bad), /catalog list of d malformed/);
  }
  assert.throws(() => catalogRelations('d', listed.filter(name => name !== 'pg_catalog.pg_statistic')),
    /pg_catalog.pg_statistic missing from d/);
});

function fakeCluster(workerSamples: number[], fail?: (db: string, query: string) => boolean) {
  const calls: { db: string; query: string }[] = [];
  let polls = 0;
  const sql = (db: string, query: string) => {
    calls.push({ db, query });
    if (fail?.(db, query)) throw new Error(`failed in ${db}`);
    if (query === databasesSQL) return JSON.stringify(['diag_1', 'postgres', 'seed_base', 'template1']);
    if (query === catalogRelationsSQL) return JSON.stringify(listed);
    if (query.startsWith('VACUUM')) return '';
    return JSON.stringify(sample(workerSamples[Math.min(polls, workerSamples.length - 1)], 0, polls++));
  };
  return { sql, calls };
}

test('every connectable database gets its catalogs analyzed, then pg_statistic vacuumed, then autovacuum must finish', async () => {
  const cluster = fakeCluster([1, 1, 0, 0, 0]);
  const evidence = await settleCatalogs('C3-r1-hot-17-base', cluster.sql, { intervalMs: 0 });
  assert.equal(evidence.status, 'settled');
  assert.deepEqual(evidence.databases, ['diag_1', 'postgres', 'seed_base', 'template1']);
  assert.deepEqual(evidence.targets.map(row => [row.database, row.relations]), evidence.databases.map(db => [db, listed]));
  const vacuums = cluster.calls.filter(call => call.query.startsWith('VACUUM'));
  assert.deepEqual(vacuums.map(call => [call.db, call.query]), evidence.databases.flatMap(db =>
    [[db, `VACUUM (ANALYZE) ${listed.join(', ')};`], [db, statisticVacuumSQL]]));
  assert.equal(statisticVacuumSQL, 'VACUUM pg_catalog.pg_statistic;', 'a plain VACUUM, which writes no statistics');
  for (const row of evidence.targets.flatMap(target => target.steps)) {
    assert.match(row.startedAt, iso);
    assert.match(row.endedAt!, iso);
    assert.ok(row.endedAt! >= row.startedAt && row.error === undefined);
  }
  assert.deepEqual(evidence.idle.map(row => row.workers), [1, 1, 0, 0, 0]);
  const lastVacuum = cluster.calls.findLastIndex(call => call.query.startsWith('VACUUM'));
  assert.ok(cluster.calls.slice(lastVacuum + 1).every(call => call.db === 'postgres'), 'idle is confirmed after the last vacuum');
});

test('idle samples are spaced by the interval', async () => {
  const started = performance.now();
  const evidence = await settleCatalogs('s', fakeCluster([0]).sql, { intervalMs: 30 });
  assert.equal(evidence.idle.length, 3);
  assert.ok(performance.now() - started >= 55, 'two waits between three samples');
});

test('a settle that never sees autovacuum finish, or is aborted, fails the setup instead of measuring', async () => {
  await assert.rejects(settleCatalogs('after seed', fakeCluster([1]).sql, { capMs: 20, intervalMs: 1 }),
    /autovacuum still running after .* \(after seed\)/);
  const controller = new AbortController();
  const waiting = settleCatalogs('s', fakeCluster([1]).sql, { intervalMs: 60000, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});

test('a malformed database or catalog list fails the setup', async () => {
  await assert.rejects(settleCatalogs('s', () => 'null'), /database list malformed/);
  await assert.rejects(settleCatalogs('s', () => '["template1"]'), /database list malformed/, 'postgres must be listed');
  await assert.rejects(settleCatalogs('s', (_db, query) => query === databasesSQL ? '["postgres"]' : '[]'),
    /catalog list of postgres malformed/);
});

test('a failed settle reports what it did before failing to every artifact writer', async () => {
  const settles: CatalogSettle[] = [], manifest: CatalogSettle[][] = [], window: CatalogSettle[] = [];
  const report = settleRecorder(settles, (all, latest) => { manifest.push(structuredClone(all)); window.push(structuredClone(latest)); });
  await settleCatalogs('after seed', fakeCluster([0]).sql, { intervalMs: 0, report });
  const cluster = fakeCluster([0], (db, query) => db === 'seed_base' && query === statisticVacuumSQL);
  await assert.rejects(settleCatalogs('C3-r1-hot-17-base', cluster.sql, { intervalMs: 0, report }), /failed in seed_base/);
  assert.deepEqual(settles.map(row => [row.stage, row.status]), [['after seed', 'settled'], ['C3-r1-hot-17-base', 'failed']]);
  for (const latest of [manifest.at(-1)!.at(-1)!, window.at(-1)!]) {
    assert.equal(latest.error, 'failed in seed_base');
    assert.deepEqual(latest.targets.map(row => row.database), ['diag_1', 'postgres', 'seed_base']);
    assert.deepEqual(latest.targets.at(-1)!.steps.map(row => row.error), [undefined, 'failed in seed_base']);
    assert.match(latest.targets.at(-1)!.steps.at(-1)!.endedAt!, iso);
  }
  assert.equal(manifest.at(-1)!.length, 2, 'the manifest keeps the earlier settled attempt');
});
