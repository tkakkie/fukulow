import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { arms, schedule, type Arm } from './c3-plan.ts';
import { validatePaths, verifyPins, verifySmoke, type Pins } from './c3-pins.ts';

const pins: Pins = { ...Object.fromEntries(arms.map((arm, index) => [arm, { ref: arm, revision: String(index).repeat(40),
  imageId: `sha256:${String(index).repeat(64)}` }])) as Record<Arm, Pins[Arm]>, harness: '3'.repeat(40) };
const paths = 'M\0server/src/messages/send/admitted.rs\0M\0server/src/messages/log.rs\0A\0server/src/messages/tests/c3.rs\0';

function mocks(inputs: { parent?: string; paths?: string; imageId?: string; imageRevision?: string; refRevision?: string; head?: string;
  mergeBase?: string; harnessPaths?: string } = {}) {
  const git = (args: string[]) => {
    if (args[0] === 'rev-parse') {
      if (args[1] === 'HEAD') return inputs.head ?? pins.harness;
      const name = args[3].split('^')[0] as Arm;
      return name === 'split' && inputs.refRevision || pins[name].revision;
    }
    if (args[0] === 'merge-base') {
      assert.deepEqual(args.slice(1), [pins.base.revision, pins.harness]);
      return inputs.mergeBase ?? pins.base.revision;
    }
    if (args[0] === 'show') return inputs.parent ?? pins.base.revision;
    if (args.includes('--name-only')) {
      assert.deepEqual(args.slice(-3), [pins.base.revision, pins.harness, '--']);
      return inputs.harnessPaths ?? 'load/diag-621/c3-run.ts\0';
    }
    assert.equal(args.at(-3), pins.base.revision);
    if (args.includes('--name-status')) return inputs.paths ?? paths;
    return 'diff content\n';
  };
  const inspect = (image: string) => ({ id: image === pins.split.imageId ? inputs.imageId ?? image : image,
    revision: image === pins.split.imageId && inputs.imageRevision || arms.map(arm => pins[arm]).find(pin => pin.imageId === image)!.revision });
  const records: Record<string, unknown> = {};
  const run = () => verifyPins(pins, git, inspect, (arm, evidence) => { records[arm] = evidence; });
  return { run, records };
}

test('all arms record actual immutable IDs, revisions, and binary diff hashes', () => {
  const model = mocks(); model.run();
  assert.deepEqual(Object.keys(model.records), arms);
  assert.deepEqual(model.records.split, { pin: pins.split, actual: { id: pins.split.imageId, revision: pins.split.revision },
    revision: pins.split.revision, paths, diffHash: createHash('sha256').update('diff content\n').digest('hex') });
});

test('reject wrong image ID, label, resolved ref, sibling parent or disallowed paths', () => {
  for (const inputs of [{ imageId: pins.base.imageId }, { imageRevision: pins.base.revision }, { refRevision: pins.base.revision }]) {
    const model = mocks(inputs);
    assert.throws(model.run, /image ID or revision mismatch/);
    assert.ok(model.records.split);
  }
  assert.throws(mocks({ parent: `${pins.base.revision} ${pins.c3.revision}` }).run, /directly on base/);
  assert.throws(mocks({ head: pins.base.revision }).run, /checkout does not match the harness/);
  assert.throws(mocks({ paths: 'M\0server/src/main.rs\0' }).run, /disallowed/);
  assert.doesNotThrow(() => validatePaths(paths));
  for (const invalid of ['', 'A\0server/migrations/c3.sql\0', 'M\0server/src/messages/tests/c3.rs\0',
    'D\0server/src/messages/log.rs\0', 'R100\0server/src/messages/log.rs\0server/src/messages/send/admitted.rs\0']) {
    assert.throws(() => validatePaths(invalid), /missing|malformed|disallowed/);
  }
});

test('harness diff cannot touch a path outside load/diag-621/', () => {
  assert.throws(mocks({ harnessPaths: 'load/diag-621/c3-run.ts\0load/diag-621-other/run.ts\0' }).run, /outside load\/diag-621/);
});

test('harness must descend from appBase', () => {
  assert.throws(mocks({ mergeBase: '4'.repeat(40) }).run, /does not descend from appBase/);
});

test('arm parented on harness instead of appBase is rejected', () => {
  assert.throws(mocks({ parent: pins.harness }).run, /directly on base/);
});

const windows = schedule(true).map(window => ({ window, valid: true, late: false }));
const report = { valid: true, smoke: true, planVersion: '4.1', warmSeconds: 10, pins, harness: pins.harness, windows };

test('full runs require valid v4.1 smoke evidence for the same pins with a 10 s warm-up', () => {
  assert.doesNotThrow(() => verifySmoke(report, pins));
  assert.throws(() => verifySmoke({ ...report, planVersion: undefined }, pins), /matching valid smoke/);
  assert.throws(() => verifySmoke({ ...report, warmSeconds: 3 }, pins), /matching valid smoke/);
  assert.throws(() => verifySmoke({ ...report, valid: false }, pins), /matching valid smoke/);
  assert.throws(() => verifySmoke({ ...report, windows: windows.slice(1) }, pins), /matching valid smoke/);
  assert.throws(() => verifySmoke({ ...report, windows: [{ ...windows[0], late: true }, ...windows.slice(1)] }, pins), /matching valid smoke/);
  assert.throws(() => verifySmoke(report, { ...pins, split: pins.c3 }), /matching valid smoke/);
});

test('full runs refuse valid smoke from a different harness revision with the same images', () => {
  const harness = '4'.repeat(40);
  assert.throws(() => verifySmoke({ ...report, harness, pins: { ...pins, harness } }, pins), /same harness revision/);
});

test('CLI saves INVALID evidence and exits 1 at the host gate without reaching Docker', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'diag621-c3-test-'));
  try {
    const output = resolve(temp, 'out');
    const pinFile = resolve(temp, 'pins.json');
    writeFileSync(pinFile, JSON.stringify(pins));
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(new URL('./c3-run.ts', import.meta.url)), output, pinFile, '--smoke'],
      { env: { ...process.env, PATH: '', FUKULOW_HOST_BUSY: '', FUKULOW_LAUNCH_JOB: '' }, stdio: 'pipe' }),
    (error: unknown) => (error as { status: number }).status === 1);
    const summary = JSON.parse(readFileSync(resolve(output, 'summary.json'), 'utf8'));
    assert.equal(summary.valid, false);
    assert.match(summary.reasons.join(), /HOST-BUSY/);
    assert.deepEqual(summary.windows, []);
    assert.ok(!('primary' in summary));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
