// SA1/SA2 are evaluated before the baseline, while there is no run to judge.
import { preflightReadback, type SessionIdentity } from './revocation-holds-preflight.ts';
import type { Readback } from './revocation-holds-native-stall.ts';

export class SetupAbort extends Error {}

export type Setup =
  | { kind: 'preflight' }
  | { kind: 'measured'; identity: SessionIdentity; loadPreflight: () => unknown };

export function requirePreflight(setup: Setup): number | undefined {
  if (setup.kind === 'preflight') return;
  try {
    const readback = preflightReadback(setup.loadPreflight(), setup.identity);
    if (readback !== undefined) return readback;
  } catch { /* An absent or unreadable result cannot authorize a run. */ }
  throw new SetupAbort('SA2: a passing preflight from this host, commit, Node version and session is required');
}

export async function startStall<T>(start: () => Promise<T>): Promise<T> {
  try { return await start(); }
  catch (error) { throw new SetupAbort(`SA1: stall helper did not start: ${(error as Error).message}`); }
}

export async function requireReadbacks(readbacks: () => Promise<Readback[]>, targets: number, expected?: number) {
  const rows = await startStall(readbacks);
  const after = expected ?? rows[0]?.after;
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after <= 0 ||
    rows.length !== targets || rows.some(row => row.after !== after)) {
    throw new SetupAbort(`SA1: expected ${targets} target SO_RCVBUF readbacks of ${after ?? 'one positive value'}, observed [${rows.map(row => row.after).join(', ')}]`);
  }
  return rows;
}
