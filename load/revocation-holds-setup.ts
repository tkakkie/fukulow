// SA1/SA2 are evaluated before the baseline, while there is no run to judge.
import { preflightReadback } from './revocation-holds-preflight.ts';
import { loadLedgerPreflight } from './revocation-holds-preflight-ledger.ts';
import type { SessionIdentity } from './revocation-holds-provenance.ts';
import type { Readback } from './revocation-holds-native-stall.ts';

export class SetupAbort extends Error {}

export type Setup =
  | { kind: 'preflight' }
  | { kind: 'measured'; identity: SessionIdentity; ledger: string; hostLedger?: string; preflightFile?: string };

export function requirePreflight(setup: Setup): number | undefined {
  if (setup.kind === 'preflight') return;
  try {
    const { identity, ledger, hostLedger, preflightFile } = setup;
    const readback = preflightFile && preflightReadback(loadLedgerPreflight(ledger, preflightFile, identity, hostLedger), identity);
    if (typeof readback === 'number') return readback;
  } catch { /* An absent or unreadable result cannot authorize a run. */ }
  throw new SetupAbort('SA2: the latest preflight for this host and session must pass and match this boot, checkout, binaries and Node version');
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
