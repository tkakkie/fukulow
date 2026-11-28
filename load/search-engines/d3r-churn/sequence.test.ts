import assert from 'node:assert/strict';
import { test } from 'node:test';
import { full, modelLabel } from './design.ts';
import { planModel, plannedSlot } from './model.ts';
import { sequence, snapshots } from './sequence.ts';

test('snapshots bracket real Sends, MODEL, idle, plain vacuum and concurrent lookup reindex in order', async () => {
  const actions: string[] = [];
  await sequence({
    sql: async text => actions.push(text),
    snapshot: async id => { actions.push(`snapshot ${id}`); },
    sends: async () => { actions.push('real Sends'); },
    model: async () => { actions.push('MODEL'); },
    idle: async () => { actions.push('idle'); },
  });
  assert.deepEqual(actions, [
    'VACUUM ANALYZE;', 'snapshot W0', 'real Sends', 'snapshot W1', 'MODEL', 'snapshot W2 MODEL',
    'idle', 'snapshot W3 IDLE', 'VACUUM public.message_search_terms;', 'snapshot W3 VACUUM',
    'REINDEX INDEX CONCURRENTLY public.message_search_terms_lookup;', 'snapshot W3 REINDEX',
  ]);
  assert.deepEqual(actions.filter(line => line.startsWith('snapshot ')).map(line => line.slice(9)), [...snapshots]);
});

test('a failed step cannot produce later snapshot labels', async () => {
  const seen: string[] = [];
  await assert.rejects(sequence({
    sql: async () => {},
    snapshot: async id => { seen.push(id); },
    sends: async () => {},
    model: async () => { throw new Error('MODEL interrupted'); },
    idle: async () => { assert.fail('idle after interruption'); },
  }), /MODEL interrupted/);
  assert.deepEqual(seen, ['W0', 'W1']);
});

test('MODEL fixes N at start, draws floor percentages once and spreads slots across the hour', async () => {
  const lines = [
    'Delete|00000000-0000-0000-0000-000000000001|00000000-0000-0000-0000-000000000004',
    'Edit|00000000-0000-0000-0000-000000000001|00000000-0000-0000-0000-000000000002',
    'Edit|00000000-0000-0000-0000-000000000002|00000000-0000-0000-0000-000000000003',
  ];
  const outputs = ['', '21', lines.join('\n'), ''];
  const sql: string[] = [];
  const result = await planModel(async text => { sql.push(text); return outputs.shift()!; });
  assert.equal(result.label, modelLabel);
  assert.equal(result.population, 21);
  assert.deepEqual(result.planned, {edit: 2, delete: 1, total: 3});
  assert.deepEqual(result.targets.map(row => row.kind), ['Delete', 'Edit', 'Edit']);
  assert.match(sql[2], new RegExp(String(full.seed)));
  assert.match(sql[2], /LIMIT 3/);
  const slots = Array.from({length: 177_000}, (_, i) => plannedSlot(i, 177_000));
  assert.equal(slots[0], 0);
  assert.equal(slots.at(-1), 179_998);
  assert.ok(slots.every((slot, index) => !index || [1, 2].includes(slot - slots[index - 1])));
});
