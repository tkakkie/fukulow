import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { backfill, disableMaintenance, fixtureChecks, fixtureReasons, maintenanceReasons, settleFixture, type Maintenance } from './c3-fixture.ts';

test('fixture uses the migration term generation and both directions of the full-row comparison for new Messages', () => {
  const migration = readFileSync(new URL('../../server/migrations/202611210725_message_search.sql', import.meta.url), 'utf8');
  assert.equal(backfill.replace('m.id AS message_id', 'm.id'), migration.match(/INSERT INTO public.message_search_terms[^;]+;/)![0]);
  assert.match(fixtureChecks, /m.seq > 100/);
  assert.match(fixtureChecks, /TABLE expected EXCEPT ALL TABLE actual.*TABLE actual EXCEPT ALL TABLE expected/);
  assert.match(fixtureChecks, /message_counts_check\(o.organization_id\)/);
  assert.match(fixtureChecks, /pg_relation_size.*message_search_terms/);
  assert.match(fixtureChecks, /pg_indexes_size.*message_search_terms/);
  const seed = settleFixture('00000000-0000-0000-0000-000000000001', ['00000000-0000-0000-0000-000000000002']);
  assert.equal(seed.match(/\bVACUUM\b/g)?.length, 1);
  assert.match(seed, /VACUUM \(FREEZE, ANALYZE\);\nCHECKPOINT;$/);
  assert.ok(seed.indexOf('INSERT INTO messages') < seed.indexOf(backfill));
  assert.ok(seed.indexOf(backfill) < seed.indexOf('VACUUM ('));
});

test('each setup or post-window integrity defect produces a reason', () => {
  const fixture = { prefillMissing: 0, wrongTerms: 0, unreadMismatches: 0, searchHeapBytes: 1, searchIndexBytes: 1 };
  const totals = { messages: 20000, counterTotal: 20000, log: 20000, badSequences: 0, nonPlain: 0, duplicateLog: 0,
    orphanChannels: 0, orphanSenders: 0, missingCreates: 0, badDigests: 0 };
  assert.deepEqual(fixtureReasons(fixture, totals, 20000), []);
  for (const [key, value] of Object.entries(fixture)) {
    assert.equal(fixtureReasons({ ...fixture, [key]: Number(!value) }, totals, 20000).length, 1, key);
  }
  for (const [key, value] of Object.entries(totals)) {
    assert.equal(fixtureReasons(fixture, { ...totals, [key]: value + 1 }, 20000).length, 1, key);
  }
});

test('maintenance checks settings, every send relation, worker coverage and count/timestamp changes', () => {
  const names = ['messages', 'channel_log', 'channel_message_sequences', 'message_search_terms', 'message_append_counts',
    'message_count_corrections', 'channel_read_positions', 'topic_read_positions', 'topics', 'message_mentions'];
  const rows = names.map((name, index): Maintenance => ({ name, oid: index + 1, main: true, disabled: true,
    vacuum: 0, analyze: 0, lastVacuum: null, lastAnalyze: null }));
  const workers = [{ wallMs: 99, workers: 0, vacuums: 0 }, { wallMs: 201, workers: 0, vacuums: 0 }];
  const check = (after = rows, samples = workers) => maintenanceReasons(rows, after, samples, 100, 200);
  assert.deepEqual(check(), []);
  for (const name of names) assert.ok(disableMaintenance.includes(`ALTER TABLE public.${name} SET (autovacuum_enabled = false)`));
  assert.match(disableMaintenance, /toast.autovacuum_enabled = false/);
  assert.match(check(rows.slice(1)).join(), /missing or malformed/);
  assert.match(check([{ ...rows[0], disabled: false }, ...rows.slice(1)]).join(), /missing or malformed/);
  assert.match(check(rows, [workers[0]]).join(), /coverage/);
  for (const change of [{ vacuum: 1 }, { analyze: 1 }, { lastVacuum: '2026-11-01T03:00:00Z' }, { lastAnalyze: '2026-11-01T03:00:00Z' }]) {
    assert.match(check([{ ...rows[0], ...change }, ...rows.slice(1)]).join(), /overlapped/);
  }
  for (const change of [{ workers: 1 }, { vacuums: 1 }]) {
    assert.match(check(rows, [workers[0], { ...workers[1], ...change }]).join(), /overlapped/);
  }
});
