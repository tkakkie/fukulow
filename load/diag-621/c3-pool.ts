const poolSize = 20;
export const incompletePreGrow = 'pool pre-grow incomplete';
export const preMarkerDisconnect = 'app backend disconnected before C3_COVERAGE_BEGIN';
export type PoolSnapshot = { wallMs: number; pids: number[] };

export function preGrowReason(pids: readonly number[]) {
  if (pids.length !== poolSize || new Set(pids).size !== poolSize) return incompletePreGrow;
}

export function markerPoolReason(preGrown: readonly number[], atMarker: readonly number[]) {
  if (preGrowReason(atMarker) || preGrown.some(pid => !atMarker.includes(pid))) return preMarkerDisconnect;
}

export type BackendActivity = { pid: number; backend_start: string; state: string | null; query: string | null };

export function attributeLateBackends(late: readonly { session: string }[], activity: readonly BackendActivity[]) {
  const byPid = new Map(activity.map(row => [row.pid, row]));
  return late.map(({ session }) => {
    const pid = Number.parseInt(session.split('.')[1], 16);
    const backend = byPid.get(pid);
    return { session, pid, backend_start: backend?.backend_start, state: backend?.state, lastTask: backend?.query || 'unattributed' };
  });
}
