import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { controlFloors, frozenFloors, permissionCheck } from './frequency-approval.ts';
import { block, containerCpusets, evidence, floors, hostAffinity, session } from './frequency-fixture.ts';

const reviewedControl = {
  stage: 'control', valid: true, frequency: { floorProposal: floors }, session: { id: session },
  evidence: { hostAffinity: hostAffinity(), hostAffinityAfter: hostAffinity(), containerCpusets: containerCpusets(), calibration: evidence },
};

function artifacts(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'fukulow-frequency-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = join(dir, 'report.json');
  const record = join(dir, 'record.json');
  const write = (value: unknown, fields: Record<string, unknown> = {}) => {
    const raw = JSON.stringify(value);
    writeFileSync(report, raw);
    writeFileSync(record, JSON.stringify({ report, date: '2026-11-24', quote: 'go',
      sha256: createHash('sha256').update(raw).digest('hex'), ...fields }));
    return record;
  };
  return { write, report };
}

test('control requires a separate successful, complete permission-check record', t => {
  const { write } = artifacts(t);
  const { open, close } = block(1).counters;
  for (const [cpu, x] of close.reads.entries()) {
    const start = open.reads[cpu];
    x.monoNs = String(BigInt(start.monoNs) + 1_000_000_000n);
    x.rawNs = String(BigInt(start.rawNs) + 1_000_000_000n);
    x.running = x.enabled = String(BigInt(start.enabled) + 1_000_000_000n);
  }
  const record = { mode: 'check', identity: open.identity, open: open.reads, close: close.reads };
  assert.equal(permissionCheck(write(record, { exit: 0 })).identity.bootId, open.identity.bootId);
  assert.throws(() => permissionCheck(write(record, { exit: 1 })), /no passed permission check/);
  assert.throws(() => permissionCheck(write({ ...record, close: close.reads.slice(0, -1) }, { exit: 0 })), /F6 missing/);
  const drifted = structuredClone(record);
  drifted.close[0].rawNs = '201001000001';
  assert.throws(() => permissionCheck(write(drifted, { exit: 0 })), /F1 CPU 0: counter identity or counting time changed/);
});

test('Rehearsal 2 requires a reviewed control report with matching digest and valid floors', t => {
  const { write } = artifacts(t);
  const r = reviewedControl;
  assert.deepEqual(controlFloors(write(r)).floors, floors);
  assert.throws(() => controlFloors(write(r, { sha256: 'f'.repeat(64) })), /hash differs/);
  assert.throws(() => controlFloors(write({ ...r, valid: false })), /did not validate/);
  assert.throws(() => controlFloors(write({ ...r, evidence: undefined })), /needs valid #796 housekeeping readbacks/);
  assert.throws(() => controlFloors(write({ ...r, evidence: { ...r.evidence, hostAffinityAfter: undefined } })), /needs valid #796 housekeeping readbacks/);
  assert.throws(() => controlFloors(write({ ...r, evidence: { ...r.evidence, containerCpusets: undefined } })), /no valid #796 container cpuset readback/);
});

test('formal binds frozen floors to the valid reviewed control report', t => {
  const { write, report } = artifacts(t);
  const valid = reviewedControl;
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const file = (value: unknown, sha256 = hash(valid), frozen = floors) => pathToFileURL(write(value, {
    version: 3, floors: frozen, control: { report, quote: 'control reviewed', date: '2026-11-24', sha256 },
    rehearsal2: { quote: 'rehearsal reviewed', date: '2026-11-25', sha256: 'f'.repeat(64) },
  }));
  assert.deepEqual(frozenFloors(file(valid)).floors, floors);
  assert.throws(() => frozenFloors(file(valid, hash(valid), { ...floors, client: ['1', '1'] })), /floors differ/);
  const wrongStage = { ...valid, stage: 'rehearsal2' };
  assert.throws(() => frozenFloors(file(wrongStage)), /hash differs/);
  assert.throws(() => frozenFloors(file(wrongStage, hash(wrongStage))), /did not validate/);
});
