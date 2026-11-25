import { createHash } from 'node:crypto';
import { arms, scheduleReason, smokeWarmup, type Arm, type Window } from './c3-plan.ts';

export type Pin = { ref: string; imageId: string; revision: string };
export type Pins = Record<Arm, Pin>;
type Git = (args: string[]) => string;
type Inspect = (image: string) => { id: string; revision: string };
const revisionPattern = /^[a-f0-9]{40}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const production = /^server\/src\/messages\/(?:send\/admitted|log)\.rs$/;
const newTest = /^server\/(?:(?:src\/messages\/tests|tests)\/(?:[a-z0-9_]+\/)*[a-z0-9_]+|src\/messages\/(?:send\/admitted|log)\/(?:tests(?:\/[a-z0-9_]+)*|c3_tests))\.rs$/;

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
  if (git(['rev-parse', 'HEAD']).trim() !== pins?.base?.revision) throw new Error('harness checkout is not the base revision');
  const revisions = new Set(), ids = new Set();
  for (const arm of arms) {
    const pin = pins?.[arm];
    if (!pin || typeof pin.ref !== 'string' || !pin.ref || !revisionPattern.test(pin.revision) || !imagePattern.test(pin.imageId)) {
      throw new Error(`${arm}: missing or malformed pin`);
    }
    const revision = git(['rev-parse', '--verify', '--end-of-options', `${pin.ref}^{commit}`]).trim();
    const actual = inspect(pin.imageId);
    const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];
    const diff = git([...diffArgs, '--binary', pins.base.revision, revision, '--']);
    const paths = git([...diffArgs, '--name-status', '-z', pins.base.revision, revision, '--']);
    record(arm, { pin, actual, revision, paths, diffHash: createHash('sha256').update(diff).digest('hex') });
    if (revision !== pin.revision || actual.revision !== pin.revision || actual.id !== pin.imageId
      || revisions.has(revision) || ids.has(actual.id)) throw new Error(`${arm}: image ID or revision mismatch`);
    if (arm !== 'base') {
      if (git(['show', '-s', '--format=%P', revision]).trim() !== pins.base.revision) {
        throw new Error(`${arm}: revision is not one commit directly on base`);
      }
      validatePaths(paths);
    }
    revisions.add(revision);
    ids.add(actual.id);
  }
}

type Smoke = { valid?: boolean; smoke?: boolean; warmSeconds?: number; pins?: Pins;
  windows?: { window: Window; valid: boolean; late: boolean }[] };

export function verifySmoke(smoke: Smoke, pins: Pins, warmSeconds: number) {
  if (smoke?.valid !== true || smoke.smoke !== true || ![3, 10].includes(warmSeconds) || smoke.warmSeconds !== warmSeconds
    || !Array.isArray(smoke.windows) || smoke.windows.some(row => row?.valid !== true || typeof row.late !== 'boolean')
    || scheduleReason(true, smoke.windows.map(row => row.window)) || smokeWarmup(smoke.windows.some(row => row.late)) !== warmSeconds
    || arms.some(arm => smoke.pins?.[arm]?.imageId !== pins?.[arm]?.imageId || smoke.pins?.[arm]?.revision !== pins?.[arm]?.revision)) {
    throw new Error('full run requires matching valid smoke evidence and its selected warm-up');
  }
}
