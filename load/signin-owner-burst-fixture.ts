import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLANS } from './signin-owner-burst-config.ts';
import { attribute, type SamplerRow } from './signin-owner-burst-locks.ts';
import { aggregate, judgeBurst, type BurstOwnerOp, type BurstRun, type OwnerKind } from './signin-owner-burst-judgment.ts';
import { readRuns } from './signin-owner-burst-aggregate.ts';

export const SHA = 'a'.repeat(40);

// A run that meets every pre-registered criterion. V = 50 ms; B0 p95 per authenticated kind 80 ms;
// C2 bound 80 + 5 * 50 = 330 ms. Database clock = harness clock + 1e6 ms. Clock brackets every 500 ms
// put the database read mid-way through a 1 ms round trip, so the offset is known to +-0.5 ms.
export const OFFSET = -1_000_000, SENDS = [60_000, 120_200, 180_400];
export const brackets = (endMs: number, offset = OFFSET, rttMs = 1) => Array.from({ length: Math.ceil(endMs / 500) + 1 }, (_, i) =>
  ({ nodeSentMs: i * 500, dbMs: i * 500 + rttMs / 2 - offset, nodeReceivedMs: i * 500 + rttMs }));
/** `retry`: that burst's first send is refused (16 x 429 back at +12 ms) and its re-send 250 ms later is admitted. */
export function run(opts: { retry?: number } = {}): BurstRun {
  const sends: number[][] = [];
  for (let i = 0, due = 60_000; i < 3; i++) { const list = opts.retry === i + 1 ? [due, due + 250] : [due]; sends.push(list); due = list.at(-1)! + 60_200; }
  const admitted = sends.map(l => l.at(-1)!), b2 = admitted[2] + 300 + 61_000, end = b2 + 70_000;
  const inB1 = (t: number) => t >= 60_000 && t < b2;
  const owner: BurstOwnerOp[] = [];
  const op = (kind: OwnerKind, sentMs: number, status: number, ms: number, burst?: number) =>
    owner.push({ kind, sentMs, endMs: sentMs + ms, ms, status, ...(burst ? { burst, burstSend: sends[burst - 1].length - 1 } : { dueMs: sentMs }) });
  for (let t = 1_000, i = 0; t < end; t += 2_000, i++) op(i % 2 ? 'native_signin' : 'web_signin', t, inB1(t) ? 429 : 200, inB1(t) ? 2 : 50);
  for (let t = 2_500, i = 0; t < end; t += 5_000, i++) op(i % 2 ? 'revoke' : 'password', t, 204, inB1(t) ? 200 : 80);
  admitted.forEach((s, i) => op(i % 2 ? 'revoke' : 'password', s + 13, 204, 300, i + 1));
  const attack: BurstRun['attack'] = sends.flatMap((list, i) => list.flatMap((s, j) => Array.from({ length: 16 }, (_, k) => {
    const refused = j < list.length - 1, status = refused || k >= 5 ? 429 : 401, ms = refused ? 12 : k < 5 ? 300 : 2;
    return { burst: i + 1, send: j, sentMs: s, status, ms, endMs: s + ms };
  })));
  const reads = Array.from({ length: Math.ceil(end / 500) }, (_, i) => ({ sentMs: i * 500, status: 200, ms: 5, dueMs: i * 500 }));
  const samples: SamplerRow[] = [];
  for (let t = 0; t < end; t += 20) {
    const inBurst = admitted.some(s => t >= s + 40 && t < s + 200);
    samples.push({ dbMs: t - OFFSET, nodeMs: t, connections: inBurst ? 7 : 4, maxWaitMs: 0, ctid: '(0,1)',
      waiting: inBurst ? [{ pid: 101, kind: 'signin' }, { pid: 102, kind: 'signin' }] : [] });
  }
  // Sign-in waits 101 and 102 are seen by the sampler; the owner wait 103 is attributed by its STATEMENT line.
  const waits = admitted.flatMap(s => [[101, 50, 110], [102, 55, 150], [103, 60, 200]].map(([pid, a, b]) => ({ pid,
    startDbMs: s + a - OFFSET, endDbMs: s + b - OFFSET, waitedMs: b - a, parts: ['transaction' as const], tuples: ['(0,1)'],
    outcome: 'acquired' as const, startMs: s + a, endMs: s + b, statementKind: pid === 103 ? 'owner' as const : 'signin' as const,
    who: pid === 103 ? 'owner' as const : 'signin' as const, whoSource: pid === 103 ? 'statement' as const : 'sampler' as const })));
  return { owner, attack, reads, samples, samplerMalformed: 0, skipped: { reads: 0, web_signin: 0, native_signin: 0, password: 0, revoke: 0 },
    skippedSlots: [], offsetMs: OFFSET, waits, lockLog: { complete: true, reasons: [] }, clockBrackets: brackets(end),
    bursts: sends.map((list, i) => ({ index: i + 1,
      sends: list.map((s, j) => ({ sentMs: s, statuses: attack.filter(a => a.burst === i + 1 && a.send === j).map(a => a.status),
        owner: j < list.length - 1 ? { decision: 'refused' as const, atMs: s + 12 } : { decision: 'fire' as const, atMs: s + 13 } })),
      admittedSend: list.length - 1, ownerOp: 'sent' as const, ownerOpSend: list.length - 1, wastedOwnerOpSends: [] })),
    phaseStartMs: { B0: 0, B1: 60_000, B2: b2 }, endMs: end, scheduleEndMs: end, poolMax: 20,
    plan: { b0Ms: 60_000, bursts: 3, b1TailMs: 61_000, b2Ms: 70_000 }, server: { poolTimeouts: 0, panics: 0, complete: true } };
}
/** Sets each wait's stored attribution to what the stored sampler rows and STATEMENT kind give (a consistent artifact). */
export const reattribute = (r: BurstRun) => { for (const w of r.waits) { const a = attribute(w, r.samples); w.who = a.who; w.whoSource = a.source; } };
/** Moves waits by `ms` on both clocks, keeping the stored record consistent. */
export const shiftWaits = (r: BurstRun, ms: number, pick: (w: BurstRun['waits'][number]) => boolean = () => true) => {
  for (const w of r.waits.filter(pick)) { w.startMs += ms; w.endMs += ms; w.startDbMs += ms; w.endDbMs += ms; }
  reattribute(r);
};
// Records keep `ms === endMs - sentMs`, as the harness writes them.
export const setMs = (o: { sentMs: number; endMs: number; ms: number }, ms: number) => { o.ms = ms; o.endMs = o.sentMs + ms; };
export const moveTo = (o: { sentMs: number; endMs: number; ms: number }, sentMs: number) => { o.sentMs = sentMs; o.endMs = sentMs + o.ms; };

let runsDir: string | undefined;
let runCount = 0;
export function writeRun(name: string, r: BurstRun, meta: object = {}) {
  runsDir ??= mkdtempSync(join(tmpdir(), 'burst-round3-'));
  const dir = join(runsDir, `${name}-${runCount++}`), id = `run-${runCount}`;
  mkdirSync(dir);
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ runId: id, mode: 'recorded', evidence: true, outcome: 'success' }));
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ runId: id, mode: 'recorded', evidence: true, complete: true, stoppedEarly: null,
    harnessCommit: SHA, serverCommit: SHA, ...r, judgment: judgeBurst(r) }));
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ project: id, mode: 'recorded', evidenceEligible: true, plan: PLANS.recorded, harnessCommit: SHA, serverCommit: SHA, ...meta }));
  return dir;
}

export const threeRuns = (r: BurstRun | (() => BurstRun), meta: object = {}) =>
  aggregate(readRuns(['x', 'y', 'z'].map(n => writeRun(n, typeof r === 'function' ? r() : structuredClone(r), meta)))).outcome;

/** Burst 1's refused send got its owner operation (11 x 429 back at +13 ms, the last five at +14 ms); the re-send is admitted. */
export function wastedRun() {
  const r = run({ retry: 1 }), s = SENDS[0];
  r.attack.filter(a => a.burst === 1 && a.send === 0).forEach((a, k) => setMs(a, k < 11 ? 13 : 14));
  r.bursts[0].sends[0].owner = { decision: 'fire', atMs: s + 13 };
  r.bursts[0].wastedOwnerOpSends = [0];
  r.owner.push({ kind: 'password', burst: 1, burstSend: 0, sentMs: s + 13, endMs: s + 63, ms: 50, status: 204 });
  return r;
}
