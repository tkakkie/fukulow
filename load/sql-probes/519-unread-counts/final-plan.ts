import { f2Blocks } from './f2-arm.ts';
import { sendBlocks } from './probe.ts';

type FinalArm = 'current' | 'final';

export function finalBenchOrder(smoke: boolean): FinalArm[][] {
  return smoke ? [['current', 'final']] : [['current', 'final'], ['final', 'current'], ['current', 'final']];
}

export function finalSendPlan(smoke: boolean, f2: boolean, control: boolean) {
  if (f2) return f2Blocks(smoke);
  if (control) return [1, 2, 3].map(order => ({ order, pair: 1, arm: 'current' as const, db: `s${order}_current` }));
  return sendBlocks(finalBenchOrder(smoke));
}
