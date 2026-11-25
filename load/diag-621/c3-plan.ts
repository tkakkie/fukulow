import type { Shape } from './plan.ts';

export const arms = ['base', 'split', 'c3'] as const;
export type Arm = typeof arms[number];
const permutations: Arm[][] = [
  ['base', 'split', 'c3'], ['base', 'c3', 'split'], ['split', 'base', 'c3'],
  ['split', 'c3', 'base'], ['c3', 'base', 'split'], ['c3', 'split', 'base'],
];
const units = [1, 2, 3, 4, 5, 6, 6, 5, 4, 3, 2, 1];
export const rate = 250;
export const measuredSeconds = 8;
export const deadlineMs = 60 * 60 * 1000;

export type Window = { id: string; index: number; round: number; shape: Shape; arm: Arm; position: number };

export function schedule(smoke: boolean): Window[] {
  const result: Window[] = [];
  for (const [unit, permutation] of (smoke ? units.slice(0, 1) : units).entries()) {
    const shapes: Shape[] = unit % 2 === 0 ? ['many-17', 'hot-17'] : ['hot-17', 'many-17'];
    for (const shape of shapes) for (const [position, arm] of permutations[permutation - 1].entries()) {
      result.push({ id: `C3-r${unit + 1}-${shape}-${arm}`, index: result.length + 1, round: unit + 1,
        shape, arm, position: position + 1 });
    }
  }
  return result;
}

export function scheduleReason(smoke: boolean, observed: readonly Window[]): string | undefined {
  const expected = schedule(smoke);
  return expected.length === observed.length && expected.every((window, index) =>
    (Object.keys(window) as (keyof Window)[]).every(key => observed[index]?.[key] === window[key]))
    ? undefined : 'recorded windows do not match the published schedule';
}

export const smokeWarmup = (late: boolean) => late ? 10 : 3;

export async function prepareWindow(window: Window, operations: {
  clone(db: string): void; disableMaintenance(db: string): void; settle(db: string): Promise<unknown>;
  restart(arm: Arm, db: string): Promise<void>;
}) {
  const db = `diag_${window.index}`;
  operations.clone(db);
  operations.disableMaintenance(db);
  // Before the app starts, so the existing readiness-to-warm-up sequence is unchanged.
  await operations.settle(db);
  await operations.restart(window.arm, db);
  return db;
}
