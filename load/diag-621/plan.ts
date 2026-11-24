// #621 C1/C2 diagnostic, rerun approved by the maintainer on 2026-11-24: diagnosis only, never a
// verdict. The 2026-11-23 run used forward/reverse/forward order; base then had 0 FPI/send and every
// candidate about 0.03, so the order now rotates as a cyclic Latin square and every arm takes every
// position equally often within each phase and shape.
export const PHASES = [['C1', ['base', 'fkc', 'fks', 'fk2', 'pk']], ['C2', ['base', 'inline']]] as const;
export type Phase = typeof PHASES[number][0];
export const OVERLAY_ARMS = ['fkc', 'fks', 'fk2', 'pk', 'inline'] as const;
export const SHAPES = ['many-17', 'hot-17'] as const;
export type Shape = typeof SHAPES[number];
// Unchanged from the 2026-11-23 run: 250/s open loop, 3 s warm-up, 8 s measured window (smoke 20/s, 10 s).
export const conditions = (smoke: boolean) => ({ rate: smoke ? 20 : 250, warmSeconds: 3, measuredSeconds: smoke ? 10 : 8 });
// Full Latin squares per phase and shape: C1 5 rounds; C2 2 squares (4 rounds) so it keeps more than 3 pairs.
const squares: Record<Phase, number> = { C1: 1, C2: 2 };

export type Window = { id: string; index: number; phase: Phase; round: number; shape: Shape; arm: string; position: number; order: string[] };

export const rotation = (arms: readonly string[], by: number) => arms.map((_, i) => arms[(i + by) % arms.length]);

// Round r runs rotation r-1 for both shapes; shape order alternates by round as before.
// Smoke: many-17 only, the first two rounds of each phase (exercises the rotation, not balanced).
export function windows(smoke: boolean): Window[] {
  const out: Window[] = [];
  for (const [phase, arms] of PHASES) {
    const rounds = smoke ? 2 : arms.length * squares[phase];
    for (let round = 1; round <= rounds; round++) {
      const order = rotation(arms, round - 1);
      const shapes: Shape[] = smoke ? ['many-17'] : round % 2 ? ['many-17', 'hot-17'] : ['hot-17', 'many-17'];
      for (const shape of shapes) order.forEach((arm, i) => out.push({
        id: `${phase}-r${round}-${shape}-${arm}`, index: out.length + 1, phase, round, shape, arm, position: i + 1, order }));
    }
  }
  return out;
}

// phase/shape/arm -> how often the arm ran at each position (1-based index into the array).
export function positionCounts(plan: readonly Window[]) {
  const counts = new Map<string, number[]>();
  for (const w of plan) {
    const key = `${w.phase}/${w.shape}/${w.arm}`;
    const row = counts.get(key) ?? Array(w.order.length).fill(0);
    row[w.position - 1]++;
    counts.set(key, row);
  }
  return counts;
}

export const balanced = (plan: readonly Window[]) =>
  [...positionCounts(plan).values()].every(row => row.every(n => n === row[0] && n > 0));
