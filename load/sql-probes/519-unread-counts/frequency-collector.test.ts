import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertHelperOrder, timedCounters } from './frequency-collector.ts';
import { policy, session } from './frequency-fixture.ts';
import { finalSendPlan } from './final-plan.ts';

test('all send plans fit the Rust helper block order range', () => {
  const protocol = readFileSync(new URL('../../harness-core/perf-helper/src/protocol.rs', import.meta.url), 'utf8');
  const limit = protocol.match(/^const MAX_BLOCK_ORDER: u8 = ([0-9]+);$/m);
  assert.ok(limit, 'Rust helper must declare its block order limit');
  const maxOrder = Number(limit[1]);
  for (const [name, smoke, f2, control] of [
    ['standard diagnostic (including F1, attribution, #796 rehearsal and formal)', false, false, false],
    ['standard smoke (including F1 and attribution)', true, false, false],
    ['F2 diagnostic', false, true, false],
    ['F2 smoke', true, true, false],
    ['#796 control', false, false, true],
  ] as const) {
    const plan = finalSendPlan(smoke, f2, control);
    assert.ok(plan.length > 0 && plan.length <= maxOrder, `${name}: ${plan.length} blocks outside helper range 1–${maxOrder}`);
    for (const { order } of plan) {
      assert.ok(order >= 1 && order <= maxOrder, `${name}: block ${order} outside helper range 1–${maxOrder}`);
    }
  }
});

test('preflight requires the installed helper to accept the planned order', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fukulow-collector-order-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = join(dir, 'helper');
  writeFileSync(helper, '#!/bin/sh\n[ "$#" -eq 2 ] && [ "$1" = "--check-order" ] && [ "$2" = "16" ]\n', { mode: 0o700 });
  assert.doesNotThrow(() => assertHelperOrder(helper, 16));
  assert.throws(() => assertHelperOrder(helper, 17), /STOP: perf helper could not validate planned block 17/);
});

test('the collector bounds waiting for the helper to exit after the closing sweep', { timeout: 10_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fukulow-collector-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const helper = join(dir, 'helper');
  writeFileSync(helper, `#!/usr/bin/env node
const input = require('node:readline').createInterface({ input: process.stdin });
console.log('{"ready":true}');
input.on('line', command => {
  console.log('{}');
  if (command === 'close') setTimeout(() => process.exit(0), 5000);
});
`, { mode: 0o700 });
  await assert.rejects(timedCounters(helper, session, 1, false, t.signal, async () => 'ok', undefined, () => policy),
    /F6 perf helper exit timed out/);
});
