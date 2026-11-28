import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { timedCounters } from './frequency-collector.ts';
import { policy, session } from './frequency-fixture.ts';

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
