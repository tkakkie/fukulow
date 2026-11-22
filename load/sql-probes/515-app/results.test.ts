import assert from 'node:assert/strict';
import test from 'node:test';
import { components, parseTraces, prefix, sqlLabels, summary, type Block } from './results.ts';
import type { Arm } from '../../slice5/config.ts';

type Event = [string, number | null, number, number];
function events(arm: Arm) {
  const list: Event[] = [];
  const us = (n: number) => n * 1000;
  let cursor = 0;
  const add = (name: string, length: number, start = cursor, index: number | null = null) => {
    list.push([name, index, us(start), us(start + length)]);
    return start + length;
  };
  function acquire() {
    const index = list.filter(([name]) => name === 'acquire').length;
    add('permit', 10);
    add('checkout', 30, cursor + 10);
    cursor = add('acquire', 50);
    return (delay = 0) => add('return', 50, cursor + delay, index);
  }
  function query(name: string, length: number, decode = 0) {
    if (decode) add('decode', decode, cursor + 5);
    cursor = add(name, length);
  }
  const auth = acquire();
  query('snapshot_begin', 30);
  query('snapshot_context', 30);
  query('session', 30, 5);
  query('snapshot_end', 30);
  auth();
  const handler = cursor;
  if (arm === 'A') {
    const visible = acquire();
    query('visibility', 30, 5);
    visible();
    const watermark = acquire();
    query('watermark_begin', 30);
    query('barrier', 30);
    query('watermark', 30, 5);
    query('watermark_commit', 30);
    watermark();
    const page = acquire();
    query('page', 60);
    page(60);
    cursor = add('page_decode', 40);
    cursor = add('response', 30);
  } else {
    const history = acquire();
    query('snapshot_begin', 30);
    query('snapshot_context', 30);
    query('visibility', 30, 5);
    query('page', 60, 30);
    cursor = add('response', 30);
    query('snapshot_end', 30);
    history(5);
  }
  add('handler', cursor - handler, handler);
  add('request', cursor + 5, 0);
  return list.reverse(); // Driver records spans on completion, including late returns.
}

const line = (id: number, list: Event[]) => prefix + JSON.stringify([id, list]);
const trace = (arm: Arm, list = events(arm), httpMs = 1) => components(arm, parseTraces(line(42, list)).get(42)!, httpMs);

test('joins request IDs and separates decoding, driver queries and async checks', () => {
  const log = ['ordinary log', line(42, events('A')), line(41, events('B'))].join('\n');
  assert.deepEqual([...parseTraces(log).keys()], [42, 41]);
  const a = trace('A'), b = trace('B');
  assert.deepEqual(a.counts, { sql: 10, checkout: 4, return: 4, connect: 0 });
  assert.deepEqual(b.counts, { sql: 9, checkout: 2, return: 2, connect: 0 });
  assert.equal(Object.keys(a.values).filter(key => key.startsWith('sql.')).length, sqlLabels.A.length);
  assert.equal(a.values['sql.page'], 0.060);
  assert.equal(b.values['sql.page'], 0.030);
  assert.equal(a.values['decode.page'], 0.040);
  assert.equal(b.values['decode.page'], 0.030);
  assert.equal(a.values['pool_checkout_total'], 0.12);
  assert.equal(a.values['replay_nonpage_sql'], 0.14);
  assert.equal(b.values['replay_nonpage_sql'], 0.115);
  assert.equal(a.values['sync_check_and_nonpage_sql'], 0.260);
  assert.equal(a.values['async_return_total'], 0.2);
  assert.equal(a.values['async_return_overlap_request'], 0.165);
  assert.equal(a.values['async_return_overlap_permits'], 0.03);
  assert.equal(a.values['component_sum'], 0.600);
  assert.equal(a.values['unexplained'], 0.4);
});

test('distinguishes a new connection from a warm checkout check', () => {
  const list = events('A');
  list.find(event => event[0] === 'checkout')![0] = 'connect';
  const a = trace('A', list);
  assert.deepEqual(a.counts, { sql: 10, checkout: 3, return: 4, connect: 1 });
  assert.equal(a.values['connect.page'], 0.03);
  assert.equal(a.values['checkout.page'], 0);
});

test('rejects corrupt, duplicate, missing and inconsistent timings', () => {
  assert.throws(() => parseTraces(prefix + '{bad'));
  assert.throws(() => parseTraces(line(42, []) + '\n' + line(42, [])), /duplicate trace ID/);
  assert.throws(() => parseTraces(line(42, [['page', null, 2, 1]])), /Invalid trace span/);
  assert.throws(() => parseTraces(line(42, [['return', null, 1, 2]])), /Invalid trace span/);
  assert.throws(() => trace('A', events('B')), /Unexpected SQL or pool path/);
  assert.throws(() => trace('A', events('A').filter(s => s[0] !== 'return')), /Unexpected SQL or pool path/);
  const dupe = events('A');
  dupe.find(s => s[0] === 'return' && s[1] === 0)![1] = 1;
  assert.throws(() => trace('A', dupe), /Unexpected SQL or pool path/);
  const outside = events('B');
  outside.push(['decode', null, 1, 2]);
  assert.throws(() => trace('B', outside), /Inconsistent latency spans/);
  assert.throws(() => trace('A', events('A'), 0.01), /Inconsistent latency spans/);
});

test('reports HTTP rank budgets, controls and the unidentified remainder', () => {
  const blocks: Block[] = [];
  for (const arm of ['A', 'B'] as const) {
    for (const variant of ['patched', 'control'] as const) {
      const httpMs = arm === 'A' ? 1 : variant === 'control' ? 0.95 : 0.8;
      blocks.push({ arm, variant, cell: '1M-recent', block: 0, samples: [
        { id: 1, after: 20, warmup: true, httpMs: 100 },
        { id: 2, after: 50, warmup: false, httpMs, ...(variant === 'patched' && { trace: trace(arm, events(arm), httpMs) }) },
      ] });
    }
  }
  const md = summary('smoke', blocks, true);
  assert.match(md, /SMOKE validation only. Never evidence/);
  assert.match(md, /no PASS\/FAIL.*3 FAIL, 1 INVALID/);
  assert.match(md, /http \(unpatched control\) \| 1.000 \/ 1.000 \| 0.950 \/ 0.950 \| 0.050/);
  assert.match(md, /p95 \| 0.200 \| 0.170 \| 0.030 \| 0.085/);
  assert.match(md, /unexplained remainder is not identified/);
  assert.match(summary('recorded', [], false), /Run incomplete/);
  assert.throws(() => summary('recorded', blocks.slice(1), true), /Missing or mismatched/);
  blocks[3].samples[1].after = 51;
  assert.throws(() => summary('recorded', blocks, true), /Mismatched cursor/);
});
