// The fixed #870 diagnostic sequences (design rev 2, approved 2026-11-24). Nothing is added, repeated
// or extended after a stage starts; the orchestrator walks these steps once.

export type Order = 'F' | 'R';
export type Arm = 'A1' | 'A2' | 'C1' | 'C2' | 'D' | 'B' | 'smoke';
// copy: template copy, restart, one warm-up sweep, measure (the #689 round). settle waits before the restart.
// hot: measure again at once on the same copy. restart-only: restart, no warm-up, measure.
export type Step =
  | {kind: 'copy'; id: string; arm: Arm; order: Order; settle: boolean}
  | {kind: 'hot' | 'restart-only'; id: string; arm: Arm; order: Order}
  | {kind: 'idle'; id: string; ms: number}
  | {kind: 'scan'; id: string};
export type Stage = 'smoke' | '1' | '2';
export type MeasuredStep = Exclude<Step, {kind: 'idle' | 'scan'}>;

export const coolDownMs = 30 * 60_000;
export const settleCapMs = 15 * 60_000;

// Copy rounds alternate F, R, F, ... in sequence order; same-copy measurements keep their copy's order,
// so the hot-to-hot noise N contains no order effect.
type Spec = {kind: 'copy'; id: string; arm: Arm; settle: boolean} | {kind: 'hot' | 'restart-only'; id: string; arm: Arm}
  | Extract<Step, {kind: 'idle' | 'scan'}>;
function build(spec: Spec[]): Step[] {
  let copies = 0;
  let order: Order = 'F';
  return spec.map(step => {
    if (step.kind === 'idle' || step.kind === 'scan') return step;
    if (step.kind === 'copy') order = copies++ % 2 === 0 ? 'F' : 'R';
    return {...step, order};
  });
}

const copy = (id: string, arm: Arm, settle = false) => ({kind: 'copy' as const, id, arm, settle});
const same = (kind: 'hot' | 'restart-only', id: string, arm: Arm) => ({kind, id, arm});
const cache = (arm: 'C1' | 'C2') => [copy(`${arm}.warm`, arm), same('hot', `${arm}.hot1`, arm),
  same('hot', `${arm}.hot2`, arm), same('restart-only', `${arm}.restart`, arm)];

export function sequence(stage: Stage): Step[] {
  if (stage === 'smoke') {
    // One copy round that exercises every new path once (restore, samplers, settle, hot, restart-only).
    return build([copy('smoke.settle', 'smoke', true), same('hot', 'smoke.hot', 'smoke'),
      same('restart-only', 'smoke.restart', 'smoke')]);
  }
  if (stage === '1') {
    return build([
      ...[1, 2, 3, 4, 5, 6].map(i => copy(`A1.${i}`, 'A1')),
      {kind: 'idle', id: 'A2.idle', ms: coolDownMs}, copy('A2.1', 'A2'), copy('A2.2', 'A2'),
      ...cache('C1'),
      copy('D.current1', 'D'), copy('D.settle1', 'D', true), copy('D.current2', 'D'), copy('D.settle2', 'D', true),
      ...cache('C2'),
    ]);
  }
  return build([
    copy('B.pre', 'B'), {kind: 'scan', id: 'B.scan'},
    copy('B.post1', 'B'), copy('B.post2', 'B'), copy('B.post3', 'B'),
    {kind: 'idle', id: 'B.idle', ms: coolDownMs}, copy('B.cool1', 'B'), copy('B.cool2', 'B'),
  ]);
}

export const ordered = <T>(querySet: readonly T[], order: Order) => order === 'F' ? [...querySet] : [...querySet].reverse();
