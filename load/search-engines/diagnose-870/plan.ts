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

// Measurement order (design rev 2 §2, with the approved decisions and the PR #871 review):
// - copy rounds alternate F, R, F, ... in sequence order (A1: F R F R F R; A2: F R; C1.warm F; C2.warm R);
// - same-copy measurements keep their copy's order (decision 1), so the hot-to-hot noise N has no order effect;
// - D is current1, settle1, settle2, current2 (decision 2) with fixed orders F, F, R, R: each judged pair
//   (settle i, current i) shares one order and the two pairs cover both, so the settle contrast is not
//   confounded with F/R (review item 6). D rounds do not advance the alternation.
type Spec = {kind: 'copy'; id: string; arm: Arm; settle: boolean; order?: Order} | {kind: 'hot' | 'restart-only'; id: string; arm: Arm}
  | Extract<Step, {kind: 'idle' | 'scan'}>;
function build(spec: Spec[]): Step[] {
  let copies = 0;
  let order: Order = 'F';
  return spec.map(step => {
    if (step.kind === 'idle' || step.kind === 'scan') return step;
    if (step.kind === 'copy') {
      const {order: fixed, ...rest} = step;
      order = fixed ?? (copies++ % 2 === 0 ? 'F' : 'R');
      return {...rest, order};
    }
    return {...step, order};
  });
}

const copy = (id: string, arm: Arm, settle = false, order?: Order) => ({kind: 'copy' as const, id, arm, settle, ...(order ? {order} : {})});
const same = (kind: 'hot' | 'restart-only', id: string, arm: Arm) => ({kind, id, arm});
const cache = (arm: 'C1' | 'C2') => [copy(`${arm}.warm`, arm), same('hot', `${arm}.hot1`, arm),
  same('hot', `${arm}.hot2`, arm), same('restart-only', `${arm}.restart`, arm)];

export function sequence(stage: Stage): Step[] {
  if (stage === 'smoke') {
    // The approved one-round smoke (§3.4): one copy round with the settle wait, so the restore, the samplers,
    // the settle wait, EXPLAIN and the restart all run once. Its numbers are not used.
    return build([copy('smoke.1', 'smoke', true)]);
  }
  if (stage === '1') {
    return build([
      ...[1, 2, 3, 4, 5, 6].map(i => copy(`A1.${i}`, 'A1')),
      {kind: 'idle', id: 'A2.idle', ms: coolDownMs}, copy('A2.1', 'A2'), copy('A2.2', 'A2'),
      ...cache('C1'),
      // D pairs (settle1, current1) in F and (settle2, current2) in R; see the order note above.
      copy('D.current1', 'D', false, 'F'), copy('D.settle1', 'D', true, 'F'),
      copy('D.settle2', 'D', true, 'R'), copy('D.current2', 'D', false, 'R'),
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
