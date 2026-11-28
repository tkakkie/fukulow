import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelLabel } from './design.ts';
import { interval, lsnBytes, parseSample, sampleSql } from './sampler.ts';
import { heapFetches, physical } from './snapshot.ts';

export function sample() {
  const at = '2026-11-28T00:00:00Z';
  const table = {n_tup_ins: 0, n_tup_upd: 0, n_live_tup: 120, n_dead_tup: 30, n_ins_since_vacuum: 28,
    autovacuum_count: 2, autoanalyze_count: 1, last_autovacuum: at, last_autoanalyze: null,
    total_autovacuum_time: 100.5, total_autoanalyze_time: 20.3};
  return {at, lsn: '1/FFFFFFFE', dbBytes: 200, dbStatsReset: null,
    bytes: {heap: 90, lookup: 80, maintenance: 30}, terms: {...table}, messages: {...table},
    vacuum: [{pid: 81, phase: 'scanning heap', relid: 100, heap_blks_scanned: 6}],
    checkpointer: {num_timed: 2, num_requested: 3, num_done: 5, buffers_written: 12, write_time: 1.25, sync_time: 0,
      stats_reset: at}};
}

test('periodic samples preserve physical sizes, vacuum counters, progress and checkpoints', () => {
  const raw = sample();
  assert.deepEqual(parseSample(JSON.stringify(raw)), raw);
  for (const source of ['pg_relation_size', 'pg_stat_user_tables', 'pg_stat_progress_vacuum', 'pg_stat_checkpointer']) {
    assert.ok(sampleSql.includes(source));
  }
  for (const source of ['pgstattuple', 'pgstatindex', 'pg_visibility_map_summary']) assert.ok(!sampleSql.includes(source));
});

test('the sampler SQL converts the vacuum relation OID from a JSON string to a number', () => {
  const raw = sample();
  const postgresRow = {...raw.vacuum[0], relid: '100'};
  assert.throws(() => parseSample(JSON.stringify({...raw, vacuum: [postgresRow]})), /Missing vacuum progress/);
  assert.match(sampleSql, /to_jsonb\(v\) \|\| jsonb_build_object\('relid', v\.relid::bigint\)/);
  const projected = {...postgresRow, relid: Number(postgresRow.relid)};
  assert.deepEqual(parseSample(JSON.stringify({...raw, vacuum: [projected]})).vacuum, raw.vacuum);
});

test('missing or malformed periodic data is rejected while no active vacuum is valid', () => {
  const raw = sample();
  for (const broken of [
    {...raw, at: null}, {...raw, lsn: 'AA'}, {...raw, bytes: {heap: 1, lookup: 2}},
    {...raw, terms: {...raw.terms, last_autoanalyze: undefined}}, {...raw, messages: null},
    {...raw, terms: {...raw.terms, total_autoanalyze_time: -1}},
    {...raw, vacuum: null}, {...raw, vacuum: [{pid: 3}]}, {...raw, checkpointer: {...raw.checkpointer, num_requested: null}},
  ]) assert.throws(() => parseSample(JSON.stringify(broken)));
  assert.deepEqual(parseSample(JSON.stringify({...raw, vacuum: []})).vacuum, []);
});

test('WAL delta handles LSN segment carry and each window uses its own denominator', () => {
  const before = sample();
  const after = sample();
  after.lsn = '2/10';
  after.messages.n_tup_ins = 6;
  after.messages.n_tup_upd = 3;
  assert.equal(lsnBytes(after.lsn) - lsnBytes(before.lsn), 18n);
  assert.deepEqual(interval('W1', before, after), {walBytes: 18, operations: 6, walBytesPerOperation: 3});
  assert.deepEqual(interval(modelLabel, before, after), {walBytes: 18, operations: 3, walBytesPerOperation: 6});
  assert.deepEqual(interval('W3 IDLE', before, after), {walBytes: 18, operations: 0, walBytesPerOperation: null});
  assert.throws(() => interval('W1', after, before), /reset/);
  assert.throws(() => interval('W1', before, {...after, checkpointer: {...after.checkpointer, stats_reset: 'changed'}}), /reset/);
});

test('snapshot visibility and lookup heap fetches preserve zero and no matching node distinctly', () => {
  const raw = {heap: {dead_tuple_percent: 20, free_percent: 22},
    lookup: {avg_leaf_density: 40, leaf_fragmentation: 2},
    maintenance: {avg_leaf_density: 90, leaf_fragmentation: 0},
    visibility: {all_visible: 8, all_frozen: 5, heap_pages: 10}};
  assert.equal(physical(JSON.stringify(raw)).allVisibleShare, 0.8);
  assert.throws(() => physical(JSON.stringify({...raw, visibility: {...raw.visibility, all_visible: 11}})), /visibility/);
  const lookup = {'Node Type': 'Index Only Scan', 'Index Name': 'message_search_terms_lookup'};
  const unrelated = {'Node Type': 'Index Only Scan', 'Index Name': 'another_index', 'Heap Fetches': 9};
  assert.deepEqual(heapFetches({'Node Type': 'Sort', Plans: [unrelated, {...lookup, 'Heap Fetches': 0},
    {...lookup, 'Heap Fetches': 42}]}), [0, 42]);
  assert.deepEqual(heapFetches(unrelated), []);
  assert.throws(() => heapFetches(lookup), /Heap Fetch|heap fetch/);
});
