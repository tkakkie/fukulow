import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('formal seed analyzes Messages and Create log after the first batch of every Organization', async t => {
  const output = mkdtempSync(join(tmpdir(), 'dm-formal-seed-test-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
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

  const events: string[] = [];
  const docker = t.mock.method(childProcess, 'execFileSync', (program: string, _args: string[], { input }: { input: string }) => {
    assert.equal(program, 'docker');
    for (const statement of input.matchAll(/INSERT INTO organizations\(|INSERT INTO messages\(|EXECUTE fixture_create_log\(|ANALYZE messages, channel_log;/g)) {
      events.push(statement[0]);
    }
  });
  syncBuiltinESMExports();
  try {
    await import('./dms-formal-seed.ts');
  } finally {
    docker.mock.restore();
    syncBuiltinESMExports();
  }

  const batch = ['INSERT INTO messages(', 'EXECUTE fixture_create_log('];
  const organization = [
    'INSERT INTO organizations(', ...batch, 'ANALYZE messages, channel_log;',
    ...Array.from({ length: 200 }, () => batch).flat(),
  ];
  assert.deepEqual(events, [...organization, ...organization, ...organization]);
});
