import { plan, steps } from './plan.ts';

export const diagnosticMode = 'DIAGNOSTIC';
export const diagnosticLabel = 'io.fukulow.move.diagnostic';
export const diagnosticCommit = '3d86c8945e316fc4ef993fc9e5db6736e9e7c067';
// Each pinned app commit has exactly one instrumentation patch; only the newer one times Part D reads.
export const diagnosticTargets: Record<string, { patch: string; readTimingSampleEvery: number | null }> = {
  [diagnosticCommit]: { patch: 'load/move/diagnostic.patch', readTimingSampleEvery: null },
  d655a3ad2795530c4a18587b7c589e58180d6ffb: { patch: 'load/move/diagnostic-d655a3a.patch', readTimingSampleEvery: 8 },
};
export const readLaneChoices = ['all', 'channels', 'topics'] as const;
export type ReadLanes = typeof readLaneChoices[number];

// The read-hook patch samples Part D reads 1 in FUKULOW_MOVE_DIAG_READ_EVERY (#758): every read in smoke,
// where both Channel-list workloads run at 2/s on one counter, 1 in 8 at full size.
export function readSampleEnvironment(every: number | null) {
  if (every === null) return undefined;
  if (!Number.isSafeInteger(every) || every < 1 || every > 1024) throw new Error('Invalid DIAGNOSTIC read sample interval');
  return { FUKULOW_MOVE_DIAG_READ_EVERY: String(every) };
}

export function attributionLabel(readLanes: ReadLanes) {
  return readLanes === 'all' ? undefined
    : `ATTRIBUTION RUN (Part D read lanes: ${readLanes} only); not the Part D Done-when load`;
}

export function diagnosticSelection(values: { diagnostic?: boolean; smoke?: boolean; sizes?: string; round?: string; image?: string;
  commit?: string; 'read-lanes'?: string }) {
  if (!values.diagnostic) {
    if (values.sizes !== undefined || values.round !== undefined || values['read-lanes'] !== undefined)
      throw new Error('--sizes, --round and --read-lanes require --diagnostic');
    return undefined;
  }
  if (values.image !== undefined) throw new Error('--diagnostic builds its own instrumented image');
  const commit = values.commit ?? diagnosticCommit;
  if (!Object.hasOwn(diagnosticTargets, commit)) throw new Error('DIAGNOSTIC requires a pinned Part D commit');
  const readLanes = values['read-lanes'] ?? 'all';
  if (!(readLaneChoices as readonly string[]).includes(readLanes)) throw new Error('Use --read-lanes all, channels or topics');
  if (values.smoke && (values.sizes !== undefined || values.round !== undefined))
    throw new Error('Diagnostic smoke uses the fixed small fixture');
  const sizes = values.sizes ?? '100';
  const round = values.round ?? '1';
  if (!['100', '1000', '100,1000'].includes(sizes) || !['1', '2', '3'].includes(round))
    throw new Error('Use --sizes 100, 1000 or 100,1000 and --round 1, 2 or 3');
  const p = { ...plan(values.smoke ?? false), mode: diagnosticMode };
  const selected: readonly number[] = p.smoke ? p.sizes : sizes.split(',').map(Number);
  const target = diagnosticTargets[commit];
  return { plan: p, commit, patch: target.patch, readLanes: readLanes as ReadLanes,
    readTimingSampleEvery: target.readTimingSampleEvery && (p.smoke ? 1 : target.readTimingSampleEvery),
    steps: steps(p).filter(step => step.part === 'D' && selected.includes(step.size) && step.round === Number(round)) };
}

export function rejectDiagnosticImage(label: string | null) {
  if (label !== null) throw new Error('DIAGNOSTIC images require --diagnostic');
}

export function rejectDiagnosticEvidence(...inputs: object[]) {
  if (inputs.some(input => 'mode' in input && input.mode === diagnosticMode))
    throw new Error('The formal judge refuses DIAGNOSTIC evidence');
}
