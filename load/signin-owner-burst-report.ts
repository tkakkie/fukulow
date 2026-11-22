// #756 recorded values per phase and per burst (pre-registration "Recorded, per phase and per burst").
// Reporting only: the judgment lives in signin-owner-burst-judgment.ts.
import type { Phase } from './signin-owner-judgment.ts';
import { distribution } from './signin-summary.ts';
import { burstAt, phaseAt, type BurstRun, type OwnerKind } from './signin-owner-burst-judgment.ts';

const KINDS: OwnerKind[] = ['web_signin', 'native_signin', 'password', 'revoke'];
const PHASES: Phase[] = ['B0', 'B1', 'B2'];
const statuses = (items: readonly { status: number }[]) => Object.fromEntries(
  [...new Set(items.map(i => i.status))].sort((a, b) => a - b).map(s => [s, items.filter(i => i.status === s).length]));
const latency = (ms: number[]) => ({ ...distribution(ms), max: ms.length ? Math.max(...ms) : null });

export function report(run: BurstRun) {
  const at = (ms: number) => phaseAt(run, ms);
  const sampleMs = (dbMs: number) => run.offsetMs === null ? NaN : dbMs + run.offsetMs;
  const phases = Object.fromEntries(PHASES.map(phase => {
    const owner = run.owner.filter(o => at(o.sentMs) === phase), reads = run.reads.filter(r => at(r.sentMs) === phase);
    const samples = run.samples.filter(s => sampleMs(s.dbMs) >= 0 && at(sampleMs(s.dbMs)) === phase);
    const waits = run.waits.filter(w => w.startMs >= 0 && at(w.startMs) === phase);
    const peakConnections = samples.reduce<typeof samples[number] | null>((p, s) => !p || s.connections > p.connections ? s : p, null);
    return [phase, {
      owner: Object.fromEntries(KINDS.map(kind => {
        const ops = owner.filter(o => o.kind === kind);
        return [kind, { statuses: statuses(ops), latencyMs: latency(ops.filter(o => o.status === 200 || o.status === 204).map(o => o.ms)) }];
      })),
      attack: statuses(run.attack.filter(a => at(a.sentMs) === phase)),
      reads: { statuses: statuses(reads), latencyMs: latency(reads.filter(r => r.status === 200).map(r => r.ms)) },
      lockLog: { count: waits.length, waitsMs: waits.map(w => w.waitedMs), maxMs: latency(waits.map(w => w.waitedMs)).max,
        owner: waits.filter(w => w.who === 'owner').map(w => w.waitedMs), unattributed: waits.filter(w => w.who === 'unknown').length,
        over1s: waits.filter(w => w.waitedMs > 1_000).length },
      sampler: { samples: samples.length, peakWaiters: Math.max(0, ...samples.map(s => s.waiting.length)),
        peakConnections: peakConnections?.connections ?? null,
        waitingShareAtPeak: peakConnections && peakConnections.connections ? peakConnections.waiting.length / peakConnections.connections : null },
    }];
  }));
  const bursts = run.bursts.map(b => {
    const attack = run.attack.filter(a => a.burst === b.index);
    const ownerOp = run.owner.find(o => o.burst === b.index) ?? null;
    const waits = run.waits.filter(w => burstAt(run.bursts, w.startMs) === b.index);
    return { burst: b.index, sends: b.sends.map(s => s.sentMs), resends: b.sends.length - 1, admittedSend: b.admittedSend,
      counted401: attack.filter(a => a.status === 401).length, refused429: attack.filter(a => a.status === 429).length,
      attack: statuses(attack), ownerOp: ownerOp && { kind: ownerOp.kind, status: ownerOp.status, ms: ownerOp.ms, error: ownerOp.error ?? null },
      ownerOpState: b.ownerOp,
      lockLog: { count: waits.length, waitsMs: waits.map(w => w.waitedMs), owner: waits.filter(w => w.who === 'owner').map(w => w.waitedMs) } };
  });
  return { phases, bursts };
}
