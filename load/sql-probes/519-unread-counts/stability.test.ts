import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { containerCpusets, hostAffinity, policy, session } from './frequency-fixture.ts';

test('the offline report reads the start, finish and container affinity files independently', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fukulow-stability-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  write('queue.json', { name: 'control', chainDir: dir, hostBusy: join(dir, 'HOST-BUSY'), jobs: [{
    name: 'control', issue: 796, go: { quote: 'go', date: '2026-11-25' }, worktree: dir, commit: '1234567',
    command: ['ignored'], out: dir,
  }] });
  write('session.json', { id: session });
  write('control-launch-check.json', { frequencyPolicy: policy });
  const report = (name: string) => {
    const out = join(dir, name);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('stability.ts', import.meta.url)),
      '--stage', 'control', '--queue', join(dir, 'queue.json'), '--out', out], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 3, result.stderr);
    return JSON.parse(readFileSync(out, 'utf8'));
  };
  write('frequency-host-affinity.json', hostAffinity());
  const missing = report('missing.json');
  assert.ok(missing.reasons.some((reason: string) => reason.startsWith('finish: missing housekeeping readback')));
  assert.ok(missing.reasons.some((reason: string) => reason.startsWith('missing frequency-container-cpusets.json')));
  const after = { ...hostAffinity(), rootTasks: { '2': { name: 'kthreadd', cpus: [0, 8], movable: true } } };
  write('frequency-host-affinity-after.json', after);
  write('frequency-container-cpusets.json', containerCpusets());
  const present = report('present.json');
  assert.deepEqual(present.evidence.hostAffinity, hostAffinity());
  assert.deepEqual(present.evidence.hostAffinityAfter, after);
  assert.deepEqual(present.evidence.containerCpusets, containerCpusets());
  assert.ok(!present.reasons.some((reason: string) => /^(?:start:|finish:|missing frequency-container-cpusets)/.test(reason)));
});
