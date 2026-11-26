// SA1/SA2 are evaluated before the baseline, while there is no run to judge.
import { preflightReadback } from './revocation-holds-preflight.ts';
import { loadLedgerPreflight } from './revocation-holds-preflight-ledger.ts';
import type { SessionIdentity } from './revocation-holds-provenance.ts';
import type { SendBufferReadback } from './revocation-holds-log.ts';
import type { Readback, TargetReadback } from './revocation-holds-native-stall.ts';

export class SetupAbort extends Error {}

export type Setup =
  | { kind: 'diagnostic'; sendBuffer?: number }
  | { kind: 'preflight'; sendBuffer: number }
  | { kind: 'measured'; identity: SessionIdentity; ledger: string; preflightFile?: string };

export function requirePreflight(setup: Setup) {
  if (setup.kind !== 'measured') return;
  try {
    const { identity, ledger, preflightFile } = setup;
    const readback = preflightFile && preflightReadback(loadLedgerPreflight(ledger, preflightFile, identity), identity);
    if (readback) return readback;
  } catch { /* An absent or unreadable result cannot authorize a run. */ }
  throw new SetupAbort('SA2: the latest preflight must pass and match this host, session, boot, checkout, binaries, Node version and requested SO_SNDBUF');
}

export async function startStall<T>(start: () => Promise<T>): Promise<T> {
  try { return await start(); }
  catch (error) { throw new SetupAbort(`SA1: stall helper did not start: ${(error as Error).message}`); }
}

export async function requireReadbacks<T extends Readback>(readbacks: () => Promise<T[]>, targets: number, expected?: number) {
  const rows = await startStall(readbacks);
  const after = expected ?? rows[0]?.after;
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after <= 0 ||
    rows.length !== targets || rows.some(row => row.after !== after)) {
    throw new SetupAbort(`SA1: expected ${targets} target SO_RCVBUF readbacks of ${after ?? 'one positive value'}, observed [${rows.map(row => row.after).join(', ')}]`);
  }
  return rows;
}

export function targetSendBuffers(targets: TargetReadback[], readbacks: SendBufferReadback[]) {
  // The target proxies connect to one loopback listener, so each upstream port identifies its accepted socket.
  const byPort = new Map<number, number[]>();
  for (const { peerPort, effective } of readbacks) {
    const values = byPort.get(peerPort);
    if (values) values.push(effective);
    else byPort.set(peerPort, [effective]);
  }
  return targets.map(({ upstreamPort }) => ({ upstreamPort, values: byPort.get(upstreamPort) ?? [] }));
}

export function requireSendBuffers(rows: ReturnType<typeof targetSendBuffers>, expected?: number) {
  const effective = expected ?? rows[0]?.values[0];
  const ports = new Set(rows.map(row => row.upstreamPort));
  if (!rows.length || !effective || !Number.isSafeInteger(effective) || effective < 1 || ports.size !== rows.length ||
      rows.some(({ values }) => values.length !== 1 || values[0] !== effective)) {
    throw new SetupAbort(`SA1: expected one SO_SNDBUF readback per target of ${expected ?? 'the same positive value'}; see send-buffer-readbacks.json`);
  }
  return effective;
}
