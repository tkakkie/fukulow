import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { controlFloors, permissionCheck } from './frequency-approval.ts';
import { block, floors } from './frequency-fixture.ts';

function artifacts(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'fukulow-frequency-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = join(dir, 'report.json');
  const record = join(dir, 'record.json');
  return (value: unknown, fields: Record<string, unknown> = {}) => {
    const raw = JSON.stringify(value);
    writeFileSync(report, raw);
    writeFileSync(record, JSON.stringify({ report, date: '2026-11-24', quote: 'go',
      sha256: createHash('sha256').update(raw).digest('hex'), ...fields }));
    return record;
  };
}

test('control requires a separate successful, complete permission-check record', t => {
  const write = artifacts(t);
  const { open, close } = block(1).counters;
  for (const [cpu, x] of close.reads.entries()) {
    const start = open.reads[cpu];
    x.monoNs = String(BigInt(start.monoNs) + 1_000_000_000n);
    x.running = x.enabled = String(BigInt(start.enabled) + 1_000_000_000n);
  }
  const record = { mode: 'check', identity: open.identity, open: open.reads, close: close.reads };
  assert.equal(permissionCheck(write(record, { exit: 0 })).identity.bootId, open.identity.bootId);
  assert.throws(() => permissionCheck(write(record, { exit: 1 })), /no passed permission check/);
  assert.throws(() => permissionCheck(write({ ...record, close: close.reads.slice(0, -1) }, { exit: 0 })), /F6 missing/);
});

test('Rehearsal 2 requires a reviewed control report with matching digest and valid floors', t => {
  const write = artifacts(t);
  const r = { stage: 'control', valid: true, frequency: { floorProposal: floors } };
  assert.deepEqual(controlFloors(write(r)).floors, floors);
  assert.throws(() => controlFloors(write(r, { sha256: 'f'.repeat(64) })), /hash differs/);
  assert.throws(() => controlFloors(write({ ...r, valid: false })), /did not validate/);
});
