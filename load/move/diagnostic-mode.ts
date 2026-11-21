import { plan, steps } from './plan.ts';

export const diagnosticMode = 'DIAGNOSTIC';
export const diagnosticLabel = 'io.fukulow.move.diagnostic';
export const diagnosticCommit = '3d86c8945e316fc4ef993fc9e5db6736e9e7c067';

export function diagnosticSelection(values: { diagnostic?: boolean; smoke?: boolean; sizes?: string; round?: string; image?: string }) {
  if (!values.diagnostic) {
    if (values.sizes !== undefined || values.round !== undefined)
      throw new Error('--sizes and --round require --diagnostic');
    return undefined;
  }
  if (values.image !== undefined) throw new Error('--diagnostic builds its own instrumented image');
  if (values.smoke && (values.sizes !== undefined || values.round !== undefined))
    throw new Error('Diagnostic smoke uses the fixed small fixture');
  const sizes = values.sizes ?? '100';
  const round = values.round ?? '1';
  if (!['100', '1000', '100,1000'].includes(sizes) || !['1', '2', '3'].includes(round))
    throw new Error('Use --sizes 100, 1000 or 100,1000 and --round 1, 2 or 3');
  const p = { ...plan(values.smoke ?? false), mode: diagnosticMode };
  const selected: readonly number[] = p.smoke ? p.sizes : sizes.split(',').map(Number);
  return { plan: p, steps: steps(p).filter(step => step.part === 'D' && selected.includes(step.size) && step.round === Number(round)) };
}

export function rejectDiagnosticImage(label: string | null) {
  if (label !== null) throw new Error('DIAGNOSTIC images require --diagnostic');
}

export function rejectDiagnosticEvidence(...inputs: object[]) {
  if (inputs.some(input => 'mode' in input && input.mode === diagnosticMode))
    throw new Error('The formal judge refuses DIAGNOSTIC evidence');
}
