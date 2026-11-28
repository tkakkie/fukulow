import { createHash } from 'node:crypto';
import { arms, planVersion, scheduleReason, warmSeconds, type Arm, type Window } from './c3-plan.ts';

export type Pin = { ref: string; imageId: string; revision: string };
export type Pins = Record<Arm, Pin> & { harness: string };
type Git = (args: string[]) => string;
type Inspect = (image: string) => { id: string; revision: string };
const revisionPattern = /^[a-f0-9]{40}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const production = /^server\/src\/messages\/(?:send\/admitted|log)\.rs$/;
const newTest = /^server\/(?:(?:src\/messages\/tests|tests)\/(?:[a-z0-9_]+\/)*[a-z0-9_]+|src\/messages\/(?:send\/admitted|log)\/(?:tests(?:\/[a-z0-9_]+)*|c3_tests))\.rs$/;
const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];

export function validatePaths(status: string) {
  const fields = status.split('\0');
  if (fields.pop() !== '' || fields.length === 0 || fields.length % 2 !== 0) throw new Error('missing or malformed arm diff');
  for (let index = 0; index < fields.length; index += 2) {
    const [kind, path] = fields.slice(index, index + 2);
    if (!((kind === 'M' && production.test(path)) || (kind === 'A' && newTest.test(path)))) {
      throw new Error('arm diff touches a disallowed path or change type');
    }
  }
}

export function verifyPins(pins: Pins, git: Git, inspect: Inspect, record: (arm: Arm, evidence: unknown) => void) {
  const appBase = pins?.base?.revision, harness = pins?.harness;
  if (typeof harness !== 'string' || !revisionPattern.test(harness)) throw new Error('missing or malformed harness pin');
  if (typeof appBase !== 'string' || !revisionPattern.test(appBase)) throw new Error('base: missing or malformed pin');
  if (git(['rev-parse', 'HEAD']).trim() !== harness) throw new Error('checkout does not match the harness pin');
  if (git(['merge-base', appBase, harness]).trim() !== appBase) throw new Error('harness does not descend from appBase');
  const harnessPaths = git([...diffArgs, '--no-relative', '--name-only', '-z', appBase, harness, '--']).split('\0');
  if (harnessPaths.pop() !== '' || harnessPaths.some(path => !path.startsWith('load/diag-621/'))) {
    throw new Error('harness diff touches a path outside load/diag-621/');
  }
  const revisions = new Set(), ids = new Set();
  for (const arm of arms) {
    const pin = pins?.[arm];
    if (!pin || typeof pin.ref !== 'string' || !pin.ref || !revisionPattern.test(pin.revision) || !imagePattern.test(pin.imageId)) {
      throw new Error(`${arm}: missing or malformed pin`);
    }
    const revision = git(['rev-parse', '--verify', '--end-of-options', `${pin.ref}^{commit}`]).trim();
    const actual = inspect(pin.imageId);
    const diff = git([...diffArgs, '--binary', appBase, revision, '--']);
    const paths = git([...diffArgs, '--name-status', '-z', appBase, revision, '--']);
    record(arm, { pin, actual, revision, paths, diffHash: createHash('sha256').update(diff).digest('hex') });
    if (revision !== pin.revision || actual.revision !== pin.revision || actual.id !== pin.imageId
      || revisions.has(revision) || ids.has(actual.id)) throw new Error(`${arm}: image ID or revision mismatch`);
    if (arm !== 'base') {
      if (git(['show', '-s', '--format=%P', revision]).trim() !== appBase) {
        throw new Error(`${arm}: revision is not one commit directly on base`);
      }
      validatePaths(paths);
    }
    revisions.add(revision);
    ids.add(actual.id);
  }
}

type Smoke = { valid?: boolean; smoke?: boolean; planVersion?: string; warmSeconds?: number; pins?: Pins; harness?: string;
  windows?: { window: Window; valid: boolean; late: boolean }[] };

export function verifySmoke(smoke: Smoke, pins: Pins) {
  if (smoke?.valid !== true || smoke.smoke !== true || smoke.planVersion !== planVersion || smoke.warmSeconds !== warmSeconds
    || typeof pins?.harness !== 'string' || !revisionPattern.test(pins.harness)
    || smoke.harness !== pins.harness || smoke.pins?.harness !== pins.harness
    || !Array.isArray(smoke.windows) || smoke.windows.some(row => row?.valid !== true || row.late !== false)
    || scheduleReason(true, smoke.windows.map(row => row.window))
    || arms.some(arm => smoke.pins?.[arm]?.imageId !== pins?.[arm]?.imageId || smoke.pins?.[arm]?.revision !== pins?.[arm]?.revision)) {
    throw new Error('full run requires matching valid smoke evidence from v4.1 on the same harness revision');
  }
}
