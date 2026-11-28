import assert from 'node:assert/strict';
import test from 'node:test';
import { sleepUnits, timerServices, updateUnits, type HostRecord } from '../../harness-core/host-record.ts';
import type { SampleLine } from '../../harness-core/thermal.ts';
import type { Session } from '../../launcher/launcher.ts';
import { judgeRun as judgeV3, replayLegacyRun as judgeRun, type RunInput } from './stability-judge.ts';

import { block, containerCpusets, evidence, floors, hostAffinity, sets796 } from './frequency-fixture.ts';
import { cpus796 } from './frequency-evidence.ts';
import { judgeChain, limits, sessionProblems } from './stability-chain.ts';
import { f2Order } from './f2-arm.ts';

const judge = (runs: RunInput[], session: Session | null, queue: string) => judgeChain(runs, session, queue, judgeRun);

const t0 = Date.parse('2026-11-25T00:00:00Z');
const cpus = [0, 1, 2, 3, 4, 5, 6, 7];
const cpuSets = { server: [0, 2, 4, 6], client: [1, 3, 5, 7] };
const host = { platform: 'linux', logicalCpus: 4, boost: '0', policyBoost: { 0: [0, 1, 2, 3] }, platformProfile: 'performance', fanControl: { 'hp/pwm1_enable': 2 } } as unknown as HostRecord; // fan automatic: L1 dropped
const arms = ['current', 'final', 'final', 'current', 'current', 'final'];
const idle = () => ({ busy: false, otherContainers: [] as string[] });
const airflow = { airflow: { quote: '蓋を開けて台に載せた', date: '2026-11-25' } };
const sid = 'L1';
const session = (names = ['s1', 's2', 's3'], over: Partial<Session> = {}): Session => ({ id: sid, queue: 'q796', outcome: 'done', hostBusy: 'released', workloadProblems: [],
  finished: '2026-11-25T03:00:00Z', jobs: names.map(name => ({ name, exit: 0, out: '/runs/' + name, workloadLabel: 'io.fukulow.probe=519-final', thermalSampleSeconds: 5, confirmations: airflow })), ...over });
const jr = (r: RunInput, thermalSampleSeconds: unknown = 5) => judgeRun(r, { id: sid, thermalSampleSeconds });

// Six 120 s pgbench intervals ending 200 s apart, each inside a slightly longer run wrapper, sampled
// every 5 s on 8 CPUs (server = even, client = odd); freq(block) gives the server and client kHz, and
// cpu(block, cpu, tick) may override one CPU's kHz and its busy fraction (default 0.9) in a tick.
type CpuTick = { khz?: number | null; busy?: number };
// ncpu replaces the 8 CPUs (server = even, client = odd, in the metadata too).
function run(name: string, over: Partial<RunInput> = {}, opts: { tps?: number; wal?: number; freq?: (block: number) => [number, number]; periodMs?: number; cpu?: (block: number, cpu: number, ms: number) => CpuTick; ncpu?: number; armOrder?: readonly string[] } = {}): RunInput {
  const all = opts.ncpu === undefined ? cpus : Array.from({ length: opts.ncpu }, (_, i) => i);
  const sets = opts.ncpu === undefined ? cpuSets : { server: all.filter(c => c % 2 === 0), client: all.filter(c => c % 2 === 1) };
  const freq = opts.freq ?? (() => [2_000_000, 2_000_000]);
  const armOrder = opts.armOrder ?? arms;
  const sends = armOrder.map((arm, i) => {
    const endMs = t0 + (i + 1) * 200_000;
    return { order: i + 1, arm, tps: (opts.tps ?? 10_000) + i, walBytesPerSend: opts.wal ?? 1787, crossed: false, errors: [] as string[],
      measuredWindow: { startMs: endMs - 121_200, endMs: endMs + 300, monoMs: 121_500 }, pgbenchWindow: { startMs: endMs - 120_000, endMs }, host: idle(), hostAfter: idle() };
  });
  const samples: SampleLine[] = [];
  const jiffies = all.map(() => [0, 0]);
  for (let ms = 0; ms <= 200_000 * armOrder.length + 100_000; ms += opts.periodMs ?? 5000) {
    const block = Math.min(armOrder.length, Math.max(1, Math.ceil(ms / 200_000)));
    const [server, client] = freq(block);
    const ticks = all.map(cpu => ({ khz: cpu % 2 === 0 ? server : client, busy: 0.9, ...opts.cpu?.(block, cpu, ms) }));
    ticks.forEach((c, cpu) => { const j = Math.round(500 * c.busy); jiffies[cpu][0] += j; jiffies[cpu][1] += 500 - j; });
    samples.push({ at: new Date(t0 + ms).toISOString(), monoMs: ms, avgFreqKHz: ticks.map(c => c.khz), procStat: jiffies.map(([b, i]) => [b, 0, 0, i, 0, 0, 0, 0]),
      temperaturesC: { 'k10temp/Tctl': 70 }, fansRpm: {}, launchSession: sid });
  }
  return { name, out: '/runs/' + name, complete: true, statusSession: sid, sends,
    metadata: { mode: 'diagnostic', sendsOnly: true, launchSession: sid, cpuSets: sets, sends: { measuredSeconds: 120 } },
    hostBefore: { ...host, launchSession: sid }, cooldown: { ok: true, maxTctlC: 50, maxWaitSeconds: 1200, readings: [{ elapsedMs: 30_000, tctlC: 49 }], launchSession: sid },
    launchCheck: { ok: true, tctlC: 48, record: host, launchSession: sid }, clockEvents: { ok: true, events: [], launchSession: sid }, samples, ...over };
}
const three = () => [run('s1'), run('s2', {}, { tps: 10_200 }), run('s3', {}, { tps: 10_400 })];

test('three valid runs of one completed session inside both spreads PASS', () => {
  const v = judge(three(), session(), 'q796');
  assert.deepEqual([v.result, v.reasons], ['PASS', []]);
  assert.deepEqual([v.runs[0].blocks[0].thermal.samples, v.runs[0].blocks[0].thermal.maxGapMs], [25, 5000]); // every tick of pgbench's 120 s window, both edges included
});

test('a tps spread over 5 % FAILs, as in the first check', () => {
  const v = judge([run('s1'), run('s2'), run('s3', {}, { tps: 7_500 })], session(), 'q796');
  assert.equal(v.result, 'FAIL');
  assert.match(v.reasons.join(), /current tps spread .* > 5 %/);
});

test('a WAL/send spread over 2 % alone FAILs; exactly 2 % passes', () => {
  const over = judge([run('s1'), run('s2'), run('s3', {}, { wal: 1787 * 1.021 })], session(), 'q796');
  assert.deepEqual([over.result, over.reasons.filter(r => /tps/.test(r))], ['FAIL', []]);
  assert.match(over.reasons.join(), /current WAL\/send spread 2\.10 % > 2 %.*final WAL\/send spread/);
  assert.equal(judge([run('s1', {}, { wal: 1000 }), run('s2', {}, { wal: 1010 }), run('s3', {}, { wal: 1020 })], session(), 'q796').result, 'PASS');
});

test('throttle: a median per-CPU drop over 5 % on either set is INVALID; exactly 5.0 % and 4.9 % are not', () => {
  const r = jr(run('s1', {}, { freq: b => [b === 5 ? 1_898_000 : 2_000_000, 2_000_000] })); // 5.1 %
  assert.deepEqual([r.valid, r.invalid], [false, ['block 5: throttled, server median per-CPU ratio 0.9490 < 0.95 of block 1 (4 CPUs)']]);
  assert.deepEqual(jr(run('s1', {}, { freq: b => [2_000_000, b === 6 ? 1_898_000 : 2_000_000] })).invalid, ['block 6: throttled, client median per-CPU ratio 0.9490 < 0.95 of block 1 (4 CPUs)']);
  assert.deepEqual(jr(run('s1', {}, { freq: b => [b === 3 ? 1_900_000 : 2_000_000, b === 4 ? 1_900_000 : 2_000_000] })).invalid, []); // exactly 5.0 %
  assert.deepEqual(jr(run('s1', {}, { freq: b => [b === 3 ? 1_902_000 : 2_000_000, b === 4 ? 1_902_000 : 2_000_000] })).invalid, []); // 4.9 %
  assert.equal(judge([run('s1', {}, { freq: b => [b > 3 ? 1_000_000 : 2_000_000, 2_000_000] }), run('s2'), run('s3')], session(), 'q796').result, 'FAIL');
  // The ratio is per CPU: two Zen 5 CPUs at 4.9 GHz and two Zen 5c at 3.47 GHz, each 6 % lower in
  // block 2, each compared with itself.
  const mixed = (b: number, cpu: number) => ({ khz: (cpu % 4 === 0 ? 4_900_000 : 3_470_000) * (b === 2 ? 0.94 : 1) });
  assert.deepEqual(jr(run('s1', {}, { cpu: (b, cpu) => (cpu % 2 === 0 ? mixed(b, cpu) : {}) })).invalid, ['block 2: throttled, server median per-CPU ratio 0.9400 < 0.95 of block 1 (4 CPUs)']);
});

test('a change in which CPUs are busy between blocks is not throttling; idle CPUs at the placeholder never lower a value', () => {
  // Server CPUs 0 and 2 (Zen 5, 4.9 GHz) are busy in block 1, CPUs 4 and 6 (Zen 5c, 3.47 GHz) idle at
  // the cpuinfo_min_freq placeholder; from block 2 on all four are busy. A pooled median over the busy
  // CPUs would fall from 4.9 to 4.18 GHz (-15 %); per CPU, nothing changed.
  const min = 623_377;
  const subset = (b: number, cpu: number): CpuTick => {
    if (cpu % 2 === 1) return {};
    const khz = cpu < 4 ? 4_900_000 : 3_470_000;
    return b === 1 && cpu >= 4 ? { khz: min, busy: 0.02 } : { khz };
  };
  assert.deepEqual(jr(run('s1', {}, { cpu: subset })).invalid, []);
  // Two of four server CPUs idle at the placeholder in block 3 (a pooled median over all four would
  // fall to 1.31 GHz); the other two hold their value, so block 3 passes.
  const idleInBlock3 = (b: number, cpu: number): CpuTick => (cpu % 2 === 0 && cpu >= 4 && b === 3 ? { khz: min, busy: 0 } : {});
  const j = jr(run('s1', {}, { cpu: idleInBlock3 }));
  assert.deepEqual(j.invalid, []);
  assert.deepEqual(j.blocks[2].thermal.server.cpus.map(c => c.valueKHz), [2_000_000, 2_000_000, null, null]);
});

test('coverage: a CPU qualifies when active in at least half of the block\'s ticks; a set needs at least half its CPUs qualifying', () => {
  // Block 2's pgbench window (80-200 s, relative to its end at 400 s: 280-400 s) holds 25 ticks.
  // Server CPUs 4 and 6 never busy; CPU 2 active in the first `n` ticks of block 2 only.
  const partial = (n: number) => (b: number, cpu: number, ms: number): CpuTick => {
    if (cpu === 4 || cpu === 6) return { busy: 0.1 };
    if (cpu === 2 && b === 2) return { busy: ms >= 280_000 && ms < 280_000 + n * 5000 ? 0.9 : 0.1 };
    return {};
  };
  const ticks = jr(run('s1')).blocks[1].thermal.ticks;
  assert.equal(ticks, 25);
  // 13 of 25 ticks (>= half): CPU 2 qualifies, 2 of 4 qualify, exactly half: judged.
  assert.deepEqual(jr(run('s1', {}, { cpu: partial(13) })).invalid, []);
  // 12 of 25 ticks (one below half): only 1 of 4 qualifies.
  assert.deepEqual(jr(run('s1', {}, { cpu: partial(12) })).invalid, ['block 2: too few active CPUs to judge frequency, server set 1 of 4 qualify']);
  // An even tick count: exactly half of the ticks qualifies. Block 2's window shortened to 24 ticks.
  const even = (n: number) => { const r = run('s1', {}, { cpu: partial(n) }); r.sends[1].pgbenchWindow = { startMs: t0 + 280_000, endMs: t0 + 399_999 }; return jr(r); };
  assert.equal(even(12).blocks[1].thermal.ticks, 24);
  assert.deepEqual(even(12).invalid.filter(x => /set/.test(x)), []);
  assert.deepEqual(even(11).invalid.filter(x => /set/.test(x)), ['block 2: too few active CPUs to judge frequency, server set 1 of 4 qualify']);
  // Half the CPUs qualify in each block but only one of them in both: not comparable, INVALID.
  const swap = (b: number, cpu: number): CpuTick => {
    if (cpu % 2 === 1) return {};
    const busyIn = b === 1 ? [0, 2] : b === 4 ? [2, 4] : [0, 2];
    return busyIn.includes(cpu) ? {} : { khz: 623_377, busy: 0.05 };
  };
  assert.deepEqual(jr(run('s1', {}, { cpu: swap })).invalid, ['block 4: server set: 1 of 4 CPUs qualify in both block 1 and this block, too few to compare']);
  // Block 1 without coverage is INVALID once; later blocks are not compared with it.
  assert.deepEqual(jr(run('s1', {}, { cpu: (b, cpu) => (b === 1 && cpu % 2 === 1 && cpu > 1 ? { busy: 0.2 } : {}) })).invalid, ['block 1: too few active CPUs to judge frequency, client set 1 of 4 qualify']);
});

test('missing frequency or /proc/stat data on an active CPU makes the run INVALID', () => {
  const mutate = (index: number, f: (x: { avgFreqKHz: (number | null)[]; procStat?: (number[] | null)[] | null }) => void) => {
    const r = run('s1');
    f(r.samples[index] as { avgFreqKHz: (number | null)[]; procStat?: (number[] | null)[] | null });
    return jr(r).invalid;
  };
  // Each such tick also counts as failed; unreadable counters fail the next tick too (its predecessor).
  assert.deepEqual(mutate(30, x => { x.avgFreqKHz[1] = null; }), ['block 1: 1 failed thermal samples', 'block 1: client set: unreadable CPU frequency on CPU 1']);
  assert.deepEqual(mutate(30, x => { x.procStat = null; }), ['block 1: 2 failed thermal samples', 'block 1: server set: unreadable /proc/stat on CPU 0', 'block 1: client set: unreadable /proc/stat on CPU 1']);
  assert.deepEqual(mutate(30, x => { delete x.procStat; }), ['block 1: 2 failed thermal samples', 'block 1: server set: unreadable /proc/stat on CPU 0', 'block 1: client set: unreadable /proc/stat on CPU 1']);
  assert.deepEqual(mutate(30, x => { x.procStat![6] = [0, 0, 0, 0, 0, 0, 0, 0]; }), ['block 1: 1 failed thermal samples', 'block 1: server set: /proc/stat counters of CPU 6 went backwards or did not advance']);
  // An idle CPU's frequency is checked too (F6: any CPU of the set).
  assert.deepEqual(jr(run('s1', {}, { cpu: (b, cpu, ms) => (cpu === 6 ? { busy: 0.1, khz: ms === 150_000 ? null : 623_377 } : {}) })).invalid,
    ['block 1: 1 failed thermal samples', 'block 1: server set: unreadable CPU frequency on CPU 6']);
  // A zero total delta: the counters did not advance since the previous tick.
  const r = run('s1');
  (r.samples[31] as { procStat: (number[] | null)[] }).procStat[5] = [...(r.samples[30] as { procStat: number[][] }).procStat[5]];
  assert.match(jr(r).invalid.join('\n'), /^block 1: client set: \/proc\/stat counters of CPU 5 went backwards or did not advance$/m);
});

type Line = { avgFreqKHz: unknown[]; procStat: unknown[][] | null };
test('F6 (round-1 blocker 1): malformed frequencies and counters are unreadable, and every counter read must not go backwards', () => {
  const at30 = (f: (x: Line) => void) => { const r = run('s1'); f(r.samples[30] as unknown as Line); return jr(r).invalid; };
  assert.deepEqual(at30(x => { for (const c of [0, 2, 4, 6]) x.avgFreqKHz[c] = 0; }), ['block 1: 1 failed thermal samples', 'block 1: server set: unreadable CPU frequency on CPU 0']);
  for (const bad of [-2_000_000, 1_999_999.5, '2000000', Infinity, NaN, true]) {
    assert.deepEqual(at30(x => { x.avgFreqKHz[2] = bad; }), ['block 1: 1 failed thermal samples', 'block 1: server set: unreadable CPU frequency on CPU 2'], String(bad));
  }
  // A null, string, fractional or negative counter (here iowait) is unreadable; so is a short line.
  for (const bad of [null, '7', 1.5, -1]) {
    assert.deepEqual(at30(x => { x.procStat![1][4] = bad; }), ['block 1: 2 failed thermal samples', 'block 1: client set: unreadable /proc/stat on CPU 1'], String(bad));
  }
  assert.deepEqual(at30(x => { x.procStat![1] = x.procStat![1].slice(0, 7); }), ['block 1: 2 failed thermal samples', 'block 1: client set: unreadable /proc/stat on CPU 1']);
  // Guest counters (beyond the 8 summed) going backwards fail closed. A line whose width changed is
  // compared on the counters both lines have (round 2: a width change alone is not missing data).
  const guest = (f: (lines: Line[]) => void) => {
    const r = run('s1');
    const lines = r.samples as unknown as Line[];
    lines.forEach((x, i) => { x.procStat![3] = [...x.procStat![3], 10 * i, 0]; });
    f(lines);
    return jr(r).invalid;
  };
  assert.deepEqual(guest(() => {}), []);
  assert.deepEqual(guest(l => { l[30].procStat![3][8] = 0; }), ['block 1: 1 failed thermal samples', 'block 1: client set: /proc/stat counters of CPU 3 went backwards or did not advance']);
  assert.deepEqual(guest(l => { l[30].procStat![3] = l[30].procStat![3].slice(0, 8); }), []);
  assert.deepEqual(guest(l => { l[30].procStat![3] = l[30].procStat![3].slice(0, 8); l[31].procStat![3][8] = 0; }), []); // 8 -> 10 columns again
  assert.deepEqual(guest(l => { l[30].procStat![3] = [...l[30].procStat![3].slice(0, 8), 10 * 30]; l[31].procStat![3][8] = 0; }),
    ['block 1: 1 failed thermal samples', 'block 1: client set: /proc/stat counters of CPU 3 went backwards or did not advance']); // guest on both, backwards
});

test('F4-F6 (round-1 blocker 2): an empty or malformed CPU set is INVALID, never a pass', () => {
  const withSets = (server: number[]) => { const r = run('s1'); r.metadata.cpuSets = { server, client: [1, 3, 5, 7] }; return jr(r); };
  const empty = withSets([]);
  assert.equal(empty.valid, false);
  assert.deepEqual(empty.invalid, ['server set is empty or not distinct CPU numbers: []']);
  assert.deepEqual(withSets([0, 0, 2, 4]).invalid, ['server set is empty or not distinct CPU numbers: [0,0,2,4]']);
  assert.equal(judge([run('s1', { metadata: { ...run('s1').metadata, cpuSets: { server: [], client: [1, 3, 5, 7] } } }), run('s2'), run('s3')], session(), 'q796').result, 'FAIL');
});

test('F5 (round-1 blocker 3): the baseline is block 1 itself; blocks numbered other than 1 to 6 are INVALID', () => {
  const r = run('s1');
  for (const s of r.sends) s.order += 1;
  assert.deepEqual(jr(r).invalid, ['blocks numbered 2,3,4,5,6,7, not 1 to 6', 'server set: no block 1 to compare frequency with', 'client set: no block 1 to compare frequency with']);
  const twice = run('s1');
  twice.sends[5].order = 5;
  assert.match(jr(twice).invalid.join('\n'), /^blocks numbered 1,2,3,4,5,5, not 1 to 6$/m);
  // Block 1 listed last is still the baseline.
  const shuffled = run('s1', {}, { freq: b => [b === 1 ? 2_200_000 : 2_000_000, 2_000_000] });
  shuffled.sends.reverse();
  assert.match(jr(shuffled).invalid.join('\n'), /block 2: throttled, server median per-CPU ratio 0\.9090 < 0\.95/);
});

test('F5 (round-1 blocker 4): the 0.95 boundary is exact, and the printed ratio is never a false inequality', () => {
  // Two of four server CPUs qualify (6 and 4 idle); ratios 13,500,004 / 30,000,009 and 43,500,016 /
  // 30,000,011. Their mean is 5.6e-17 below 0.95, which a floating-point median rounds to 0.95.
  const values: Record<number, [number, number]> = { 0: [30_000_009, 13_500_004], 2: [30_000_011, 43_500_016] };
  const fp = (b: number, cpu: number): CpuTick => (cpu === 4 || cpu === 6 ? { busy: 0.1 } : cpu in values ? { khz: values[cpu][b === 2 ? 1 : 0] } : {});
  assert.deepEqual(jr(run('s1', {}, { cpu: fp })).invalid, ['block 2: throttled, server median per-CPU ratio 0.9499 < 0.95 of block 1 (2 CPUs)']);
  // 2,000,000 -> 1,899,999 kHz: INVALID, printed rounded down.
  assert.deepEqual(jr(run('s1', {}, { freq: b => [b === 2 ? 1_899_999 : 2_000_000, 2_000_000] })).invalid, ['block 2: throttled, server median per-CPU ratio 0.9499 < 0.95 of block 1 (4 CPUs)']);
  // 0.94996 is not rounded up to 0.950.
  assert.deepEqual(jr(run('s1', {}, { freq: b => [b === 2 ? 1_899_920 : 2_000_000, 2_000_000] })).invalid, ['block 2: throttled, server median per-CPU ratio 0.9499 < 0.95 of block 1 (4 CPUs)']);
  // The median, not the mean, of the ratios: 1, 1, 1 and 0.7 is a median of 1 (mean 0.925).
  assert.deepEqual(jr(run('s1', {}, { cpu: (b, cpu) => (cpu === 6 && b === 2 ? { khz: 1_400_000 } : {}) })).invalid, []);
  // An even count takes the mean of the two middle ratios exactly: 0.94 and 0.96 with two at 1 -> 0.98.
  assert.deepEqual(jr(run('s1', {}, { cpu: (b, cpu) => (b === 2 && cpu === 0 ? { khz: 1_880_000 } : b === 2 && cpu === 2 ? { khz: 1_920_000 } : {}) })).invalid, []);
});

test('F1, F3, F4 boundaries are wired to the approved values: busy 0.5, half the ticks, half of an odd-sized set rounded up', () => {
  // Three of four server CPUs at busy 0.49 (245 of 500 jiffies): not active, 1 of 4 qualify. At 0.5: all qualify.
  const busy = (x: number) => jr(run('s1', {}, { cpu: (_, cpu) => (cpu === 2 || cpu === 4 || cpu === 6 ? { busy: x } : {}) })).invalid;
  assert.deepEqual(busy(0.49), [1, 2, 3, 4, 5, 6].map(b => `block ${b}: too few active CPUs to judge frequency, server set 1 of 4 qualify`));
  assert.deepEqual(busy(0.5), []);
  // A set of 3 needs 2 qualifying (1.5 rounded up), not 1.
  const odd = (qualify: number[]) => { const r = run('s1', {}, { cpu: (_, cpu) => (cpu % 2 === 0 && !qualify.includes(cpu) ? { busy: 0.1 } : {}) }); r.metadata.cpuSets = { server: [0, 2, 4], client: [1, 3, 5, 7] }; return jr(r).invalid; };
  assert.deepEqual(odd([0]), [1, 2, 3, 4, 5, 6].map(b => `block ${b}: too few active CPUs to judge frequency, server set 1 of 3 qualify`));
  assert.deepEqual(odd([0, 2]), []);
});

test('round 2: boundaries just inside the approved values are caught (busy 0.498, shares 0.49, odd F5 minimum, unrounded medians)', () => {
  // F1: busy 0.498 (249 of 500 jiffies) is idle, like 0.49.
  assert.deepEqual(jr(run('s1', {}, { cpu: (_, cpu) => (cpu === 2 || cpu === 4 || cpu === 6 ? { busy: 0.498 } : {}) })).invalid,
    [1, 2, 3, 4, 5, 6].map(b => `block ${b}: too few active CPUs to judge frequency, server set 1 of 4 qualify`));
  // F3: 25 of 51 ticks (0.4902) does not qualify. Block 2's window widened to 150-400 s (51 ticks);
  // server CPUs 4 and 6 idle, CPU 2 active in 25 (or 26) of those ticks.
  const ticks = (n: number) => {
    const r = run('s1', {}, { cpu: (_, cpu, ms) => (cpu === 4 || cpu === 6 ? { busy: 0.1 } : cpu === 2 && ms >= 150_000 && ms <= 400_000 ? { busy: ms < 150_000 + n * 5000 ? 0.9 : 0.1 } : {}) });
    r.sends[1].pgbenchWindow = { startMs: t0 + 150_000, endMs: t0 + 400_000 };
    r.sends[1].measuredWindow = { startMs: t0 + 149_000, endMs: t0 + 401_000, monoMs: 252_000 };
    const j = jr(r);
    assert.equal(j.blocks[1].thermal.ticks, 51);
    return j.invalid.filter(x => /^block 2: too few/.test(x));
  };
  assert.deepEqual(ticks(25), ['block 2: too few active CPUs to judge frequency, server set 1 of 4 qualify']);
  assert.deepEqual(ticks(26), []);
  // F4: 25 of 51 server CPUs (0.4902) qualifying is too few; 26 is enough.
  const wide = (n: number) => jr(run('s1', {}, { ncpu: 102, cpu: (_, cpu) => (cpu % 2 === 0 && cpu >= 2 * n ? { busy: 0.1 } : {}) })).invalid;
  assert.deepEqual(wide(25), [1, 2, 3, 4, 5, 6].map(b => `block ${b}: too few active CPUs to judge frequency, server set 25 of 51 qualify`));
  assert.deepEqual(wide(26), []);
  // F5's common minimum, the same share: 26 qualify in each block but only 25 in both.
  const shift = jr(run('s1', {}, { ncpu: 102, cpu: (b, cpu) => {
    if (cpu % 2 === 1) return {};
    const k = cpu / 2;
    return (b === 4 ? k >= 1 && k <= 26 : k <= 25) ? {} : { busy: 0.1 };
  } })).invalid;
  assert.deepEqual(shift, ['block 4: server set: 25 of 51 CPUs qualify in both block 1 and this block, too few to compare']);
  // F5's common minimum on an odd set: 2 of 3 qualify in each block, 1 in both: INVALID (1.5 rounded up).
  const odd = run('s1', {}, { cpu: (b, cpu) => (cpu % 2 === 1 ? {} : (b === 4 ? [2, 4] : [0, 2]).includes(cpu) ? {} : { busy: 0.1 }) });
  odd.metadata.cpuSets = { server: [0, 2, 4], client: [1, 3, 5, 7] };
  assert.deepEqual(jr(odd).invalid, ['block 4: server set: 1 of 3 CPUs qualify in both block 1 and this block, too few to compare']);
  // A per-CPU median of 1,899,999.5 kHz against 2,000,000 kHz is a drop over 5 %: not rounded to whole kHz.
  // Block 2's 25 ticks: one idle, 12 active at 1,899,999 and 12 at 1,900,000 on every server CPU.
  let k = 0;
  const half = run('s1', {}, { cpu: (b, cpu, ms) => {
    if (b !== 2 || cpu % 2 === 1 || ms < 280_000 || ms > 400_000) return {};
    if (cpu === 0) k++;
    const i = (ms - 280_000) / 5000;
    return i === 0 ? { busy: 0.1, khz: 623_377 } : { khz: i % 2 ? 1_899_999 : 1_900_000 };
  } });
  assert.equal(k, 25);
  const j = jr(half);
  assert.deepEqual(j.blocks[1].thermal.server.cpus[0].mid, [1_899_999, 1_900_000]);
  assert.deepEqual(j.invalid, ['block 2: throttled, server median per-CPU ratio 0.9499 < 0.95 of block 1 (4 CPUs)']);
});

const setFreq = (r: RunInput, from: number, to: number, khz: number) => {
  for (const x of r.samples as { at: string; monoMs: number; avgFreqKHz: number[] }[]) if (x.monoMs >= from && x.monoMs <= to) x.avgFreqKHz = cpus.map(c => (c % 2 === 0 ? khz : 2_000_000));
};

test('the block is judged on pgbench\'s own interval, not on the run wrapper around it', () => {
  // Block 5: pgbench ran 881-1000 s; its ticks (885-1000 s) are 13 at 1.78 GHz and 11 at 2.00 GHz:
  // throttled. Its run wrapper (869.8-1011 s) adds 2.00 GHz start-up and teardown ticks,
  // which as the window would lift the median to 2.00 GHz.
  const r = run('s1');
  setFreq(r, 885_000, 945_000, 1_780_000);
  r.sends[4].measuredWindow = { startMs: t0 + 869_800, endMs: t0 + 1_011_000, monoMs: 141_200 };
  r.sends[4].pgbenchWindow = { startMs: t0 + 881_000, endMs: t0 + 1_000_000 };
  const j = jr(r);
  assert.deepEqual(j.invalid, ['block 5: throttled, server median per-CPU ratio 0.8900 < 0.95 of block 1 (4 CPUs)']);
  assert.equal(j.blocks[4].thermal.samples, 24);
  // A healthy run with 11 s of Docker and connection overhead around the 120 s is not rejected.
  const slowStart = run('s1');
  slowStart.sends[0].measuredWindow = { startMs: t0 + 69_000, endMs: t0 + 200_500, monoMs: 131_500 };
  assert.deepEqual(jr(slowStart).invalid, []);
});

test('a wall-clock step over 50 ms makes the run INVALID; every tick in pgbench\'s window counts, none dropped at an edge', () => {
  // The step along a block's thermal ticks, on the sampler's monotonic clock: from 950 s on (inside
  // block 5) the sampler's stamps are off by `ms`. 50 ms passes, 51 ms either way is a step.
  const stepAt = (ms: number) => {
    const r = run('s1');
    for (const x of r.samples as { at: string; monoMs: number }[]) if (x.monoMs >= 950_000) x.at = new Date(t0 + x.monoMs + ms).toISOString();
    return jr(r);
  };
  assert.deepEqual(stepAt(50).invalid, []);
  assert.deepEqual(stepAt(51).invalid, ['block 5: wall clock stepped against the sampler\'s monotonic clock (51 ms)']);
  assert.deepEqual(stepAt(-50).invalid, []);
  assert.deepEqual(stepAt(-51).invalid, ['block 5: wall clock stepped against the sampler\'s monotonic clock (51 ms)']);
  // The #875 round-3 case: a +0.9 s step would pull a tick taken 0.5 s before pgbench into its window.
  // The run is INVALID, never judged on the misplaced tick.
  const pulled = run('s1');
  setFreq(pulled, 885_000, 940_000, 1_850_000);
  for (const x of pulled.samples as { at: string; monoMs: number }[]) if (x.monoMs >= 880_000) x.at = new Date(t0 + x.monoMs + 900).toISOString();
  pulled.sends[4].pgbenchWindow = { startMs: t0 + 880_500, endMs: t0 + 1_000_500 };
  pulled.sends[4].measuredWindow = { startMs: t0 + 879_000, endMs: t0 + 1_001_000, monoMs: 122_000 };
  assert.match(jr(pulled).invalid.join('\n'), /block 5: wall clock stepped against the sampler's monotonic clock \(900 ms\)/);
  // The step across one measured run, on the probe's own clocks: 50 ms passes, 51 ms either way does not.
  const wrapper = (monoMs: number) => { const r = run('s1'); r.sends[1].measuredWindow = { ...r.sends[1].measuredWindow!, monoMs }; return jr(r).invalid; };
  assert.deepEqual(wrapper(121_450), []);
  assert.deepEqual(wrapper(121_550), []);
  assert.deepEqual(wrapper(121_449), ['block 2: wall clock stepped (121500 ms wall, 121449 ms monotonic)']);
  assert.deepEqual(wrapper(121_551), ['block 2: wall clock stepped (121500 ms wall, 121551 ms monotonic)']);
  // The #875 round-3 blocker: a genuine failed tick 0.5 s before pgbench's end is counted, not dropped.
  const edgeFail = run('s1');
  edgeFail.sends[4].pgbenchWindow = { startMs: t0 + 880_500, endMs: t0 + 1_000_500 };
  edgeFail.sends[4].measuredWindow = { startMs: t0 + 879_000, endMs: t0 + 1_001_000, monoMs: 122_000 };
  const i = edgeFail.samples.findIndex(x => x.at === new Date(t0 + 1_000_000).toISOString());
  edgeFail.samples[i] = { at: edgeFail.samples[i].at, error: 'EIO', launchSession: sid, monoMs: 1_000_000 };
  assert.match(jr(edgeFail).invalid.join('\n'), /block 5: 1 failed thermal samples/);
  // And a throttled tick right on the start edge counts toward the median.
  const edgeSlow = run('s1');
  setFreq(edgeSlow, 880_000, 940_000, 1_850_000);
  edgeSlow.sends[4].pgbenchWindow = { startMs: t0 + 880_000, endMs: t0 + 1_000_000 - 1 };
  edgeSlow.sends[4].measuredWindow = { startMs: t0 + 879_000, endMs: t0 + 1_001_000, monoMs: 122_000 };
  assert.deepEqual([jr(edgeSlow).blocks[4].thermal.ticks, jr(edgeSlow).invalid], [24, ['block 5: throttled, server median per-CPU ratio 0.9250 < 0.95 of block 1 (4 CPUs)']]);
});

test('a wall-clock set in the journal during the run, or no readable journal check, makes the run INVALID', () => {
  // The #875 final-review case: a step undone between two ticks leaves no offset, but the journal keeps it.
  const set = jr(run('s1', { clockEvents: { ok: true, events: ['chronyd: System clock was stepped by -0.900000 seconds'], launchSession: sid } }));
  assert.deepEqual(set.invalid, ['wall clock set during the run: chronyd: System clock was stepped by -0.900000 seconds']);
  assert.deepEqual(jr(run('s1', { clockEvents: null })).invalid, ['clock events is not from launcher session L1', 'no readable journal clock check for the run (missing)']);
  assert.deepEqual(jr(run('s1', { clockEvents: { ok: false, events: [], problem: 'journalctl failed', launchSession: sid } })).invalid, ['no readable journal clock check for the run (journalctl failed)']);
  assert.deepEqual(jr(run('s1', { clockEvents: { ok: true, events: [], launchSession: 'L0' } })).invalid, ['clock events is not from launcher session L1']);
  assert.equal(judge([run('s1', { clockEvents: null }), run('s2'), run('s3')], session(), 'q796').result, 'FAIL');
});

test('a missing, cut, misplaced or clock-stepped pgbench window makes the run INVALID', () => {
  const cases: [(r: RunInput) => void, RegExp][] = [
    [r => { delete r.sends[4].pgbenchWindow; }, /^block 5: no pgbench window$/],
    [r => { r.sends[4].pgbenchWindow = null; }, /^block 5: no pgbench window$/],
    [r => { delete r.sends[4].measuredWindow; }, /^block 5: no measured window$/],
    [r => { r.sends[1].measuredWindow = { ...r.sends[1].measuredWindow!, monoMs: 120_000 }; }, /^block 2: wall clock stepped \(121500 ms wall, 120000 ms monotonic\)$/],
    [r => { r.sends[2].pgbenchWindow = { startMs: t0 + 400_000, endMs: t0 + 600_000 - 0 }; r.sends[2].measuredWindow = { startMs: t0 + 480_000, endMs: t0 + 601_000, monoMs: 121_000 }; }, /^block 3: pgbench window outside the measured run$/],
    [r => { r.sends[3].pgbenchWindow = { startMs: t0 + 681_000 + 1, endMs: t0 + 800_000 }; }, /^block 4: pgbench ran 118999 ms, not 120 s$/],
  ];
  for (const [mutate, pattern] of cases) {
    const r = run('s1');
    mutate(r);
    const j = jr(r);
    assert.equal(j.valid, false, String(pattern));
    assert.match(j.invalid[0], pattern);
  }
  const exact = run('s1');
  exact.sends[3].pgbenchWindow = { startMs: t0 + 681_000, endMs: t0 + 800_000 }; // 1 s short: pgbench's start-up allowance
  assert.deepEqual(jr(exact).invalid, []);
});

test('cadence: a late tick passes, a missed tick, a slow period or a session period other than 5 s does not', () => {
  const shift = (r: RunInput, index: number, ms: number) => {
    const x = r.samples[index] as { at: string; monoMs: number };
    x.monoMs += ms;
    x.at = new Date(Date.parse(x.at) + ms).toISOString();
  };
  const late = run('s1');
  shift(late, 20, 400); // 0.4 s late: gaps 5.4 s and 4.6 s; the next tick is back on its target
  assert.deepEqual(jr(late).invalid, []);
  const later = run('s1');
  shift(later, 20, 600);
  assert.deepEqual(jr(later).invalid, ['block 1: missing 5 s thermal tick (gap 5600 ms)']);
  // Every gap 5.45 s is within the per-tick lateness, but a block then has too few ticks.
  const slow = jr(run('s1', {}, { periodMs: 5450 }));
  assert.match(slow.invalid.join('\n'), /block 1: 22 thermal ticks, fewer than the 23 of a 5 s cadence/);
  assert.doesNotMatch(slow.invalid.join('\n'), /missing 5 s thermal tick/);
  // The period comes from the launcher session; a queue copy cannot supply it.
  assert.match(jr(run('s1'), 7).invalid.join(), /thermal samples every 7 s in the launcher session, not 5 s/);
  assert.match(jr(run('s1'), null).invalid.join(), /thermal samples every \(none\) s in the launcher session/);
  const v = judge(three(), { ...session(), jobs: session().jobs.map((x, i) => (i === 1 ? { ...x, thermalSampleSeconds: 7 } : x)) }, 'q796');
  assert.match(v.reasons.join(), /s2 INVALID/);
  assert.match(v.runs[1].invalid.join(), /every 7 s in the launcher session/);
  // Ticks without the sampler's monotonic stamp cannot be judged.
  const noMono = run('s1');
  delete (noMono.samples[18] as { monoMs?: number }).monoMs;
  assert.match(jr(noMono).invalid.join(), /block 1: thermal ticks without a monotonic stamp/);
});

test('every artefact must carry the judged launcher session id', () => {
  const other = 'L0';
  const cases: [(r: RunInput) => void, RegExp][] = [
    [r => { r.metadata.launchSession = other; }, /^metadata\.json is not from launcher session L1$/],
    [r => { r.statusSession = undefined; }, /^status\.json is not from launcher session L1$/],
    [r => { r.hostBefore = { ...host, launchSession: other }; }, /^host-before is not from launcher session L1$/],
    [r => { r.cooldown = { ...r.cooldown!, launchSession: other }; }, /^cool-down is not from launcher session L1$/],
    [r => { r.launchCheck = { ...r.launchCheck!, launchSession: undefined }; }, /^launch check is not from launcher session L1$/],
    // An earlier session's samples left in the same file (appended to) are mixed ids.
    [r => { r.samples.unshift({ at: new Date(t0 - 5_000).toISOString(), avgFreqKHz: [1, 1, 1, 1], temperaturesC: null, fansRpm: null, launchSession: other }); }, /^1 thermal lines not from launcher session L1$/],
    [r => { r.samples[3] = { at: r.samples[3].at, error: 'EIO' }; }, /^1 thermal lines not from launcher session L1$/],
  ];
  for (const [mutate, pattern] of cases) {
    const r = run('s1');
    mutate(r);
    const j = jr(r);
    assert.equal(j.valid, false, String(pattern));
    assert.match(j.invalid[0], pattern);
    assert.equal(judge([r, run('s2'), run('s3')], session(), 'q796').result, 'FAIL');
  }
  // No session id at all: nothing binds, every run is INVALID and the session is refused.
  const v = judge(three(), session(undefined, { id: '' }), 'q796');
  assert.equal(v.result, 'FAIL');
  assert.match(v.reasons.join('\n'), /launcher session has no id[\s\S]*s1 INVALID/);
  assert.match(v.runs[0].invalid.join(), /metadata\.json is not from launcher session \(none\)/);
});

test('a cool-down record whose accepted reading is late or hot makes the run INVALID', () => {
  for (const readings of [[{ elapsedMs: 1_200_001, tctlC: 49 }], [{ elapsedMs: 1_000, tctlC: 51 }], []]) {
    const r = run('s1');
    r.cooldown = { ...r.cooldown!, readings };
    assert.match(jr(r).invalid.join(), /the cool-down's accepted reading is not <= 50 °C within 1200 s/, JSON.stringify(readings));
  }
});

test('a failed, missing or torn thermal tick in a block makes the run INVALID (no allowance)', () => {
  const failedTick = run('s1');
  failedTick.samples[20] = { at: failedTick.samples[20].at, error: 'EIO' }; // 100 s, inside block 1
  assert.match(jr(failedTick).invalid.join(), /block 1: 2 failed thermal samples.*block 1: server set: failed thermal tick/); // the next tick has no usable predecessor
  const missing = run('s1');
  missing.samples.splice(20, 1);
  const r = jr(missing);
  assert.deepEqual(r.invalid, ['block 1: missing 5 s thermal tick (gap 10000 ms)']);
  const torn = run('s1');
  torn.samples.push({ at: null, error: 'unparseable line' });
  assert.match(jr(torn).invalid.join(), /1 thermal lines without a time/);
  const unreadable = run('s1');
  unreadable.samples[30] = { ...unreadable.samples[30], avgFreqKHz: [null, 1, 1, 1, 1, 1, 1, 1] } as SampleLine;
  assert.match(jr(unreadable).invalid.join(), /block 1: server set: unreadable CPU frequency on CPU 0/);
});

test('a missing lever, cool-down, launch check, procedure or thermal record makes the run INVALID', () => {
  const cases: [Partial<RunInput>, RegExp][] = [
    [{ hostBefore: { ...host, boost: '1' } as HostRecord }, /lever: boost is 1/],
    [{ hostBefore: { ...host, policyBoost: { 0: [0, 1], 1: [2, 3] } } as unknown as HostRecord }, /lever: per-CPU boost is not 0 on every CPU/],
    [{ hostBefore: { ...host, platformProfile: 'balanced' } as HostRecord }, /lever: platform profile/],
    [{ hostBefore: null }, /no host record/],
    [{ cooldown: null }, /no passed cool-down/],
    [{ cooldown: { ok: true, maxTctlC: 60, maxWaitSeconds: 1200 } }, /no passed cool-down/],
    [{ launchCheck: null }, /no passed launch check/],
    [{ launchCheck: { ok: true, tctlC: 51, record: host } }, /no passed launch check/],
    [{ launchCheck: { ok: true, tctlC: 45, record: { ...host, boost: '1' } as HostRecord } }, /lever at launch: boost is 1/],
    [{ samples: [] }, /block 1: missing 5 s thermal tick \(gap Infinity ms\)/],
    [{ metadata: { mode: 'diagnostic', sendsOnly: true, cpuSets: null, sends: { measuredSeconds: 120 } } }, /no CPU sets/],
    [{ metadata: { mode: 'diagnostic', sendsOnly: false, cpuSets, sends: { measuredSeconds: 120 } } }, /not the #519 send diagnosis/],
    [{ metadata: { mode: 'smoke', sendsOnly: true, cpuSets, sends: { measuredSeconds: 120 } } }, /not the #519 send diagnosis/],
    [{ complete: false }, /did not complete/],
  ];
  for (const [over, pattern] of cases) {
    const r = jr(run('s1', over));
    assert.equal(r.valid, false, String(pattern));
    assert.match(r.invalid.join('\n'), pattern);
  }
});

test('the fan mode never decides validity (L1 dropped on #796), while boost, per-CPU boost and platform profile still do', () => {
  for (const fanControl of [{ 'hp/pwm1_enable': 2 }, { 'hp/pwm1_enable': 0 }, {}, null]) {
    const record = { ...host, fanControl } as HostRecord;
    const r = jr(run('s1', { hostBefore: { ...record, launchSession: sid }, launchCheck: { ok: true, tctlC: 48, record, launchSession: sid } }));
    assert.deepEqual([r.valid, r.invalid], [true, []], JSON.stringify(fanControl));
  }
  const fan = { fanControl: { 'hp/pwm1_enable': 2 } };
  const wrong: [Record<string, unknown>, RegExp][] = [
    [{ boost: '1' }, /boost is 1, required 0/],
    [{ policyBoost: { 0: [0, 1], 1: [2, 3] } }, /per-CPU boost is not 0 on every CPU/],
    [{ platformProfile: 'balanced' }, /platform profile is balanced, required performance/],
  ];
  for (const [over, pattern] of wrong) {
    const record = { ...host, ...fan, ...over } as unknown as HostRecord;
    const before = jr(run('s1', { hostBefore: { ...record, launchSession: sid } }));
    assert.equal(before.valid, false, String(pattern));
    assert.match(before.invalid.join('\n'), new RegExp('lever: ' + pattern.source));
    const atLaunch = jr(run('s1', { launchCheck: { ok: true, tctlC: 48, record, launchSession: sid } }));
    assert.equal(atLaunch.valid, false, String(pattern));
    assert.match(atLaunch.invalid.join('\n'), new RegExp('lever at launch: ' + pattern.source));
  }
});

test('each host observation must be present and idle, before and after every block', () => {
  const cases: [(r: RunInput) => void, RegExp][] = [
    [r => { r.sends[1].host = { busy: true, otherContainers: [] }; }, /block 2: host busy before/],
    [r => { r.sends[1].hostAfter = { busy: false, otherContainers: ['other'] }; }, /block 2: other containers after/],
    [r => { r.sends[2].hostAfter = null; }, /block 3: no host observation after/],
    [r => { delete r.sends[2].host; }, /block 3: no host observation before/],
    [r => { r.sends[3].host = { busy: false }; }, /block 4: no container list before/],
  ];
  for (const [mutate, pattern] of cases) {
    const r = run('s1');
    mutate(r);
    const j = jr(r);
    assert.deepEqual([j.valid, j.invalid.length], [false, 1], String(pattern));
    assert.match(j.invalid[0], pattern);
  }
});

test('the verdict needs one completed session that ran exactly the three jobs, released HOST-BUSY and recorded L3', () => {
  const names = ['s1', 's2', 's3'];
  const runs = names.map(name => ({ name, out: '/runs/' + name }));
  assert.deepEqual(sessionProblems(session(), 'q796', runs), []);
  const cases: [Session | null, RegExp][] = [
    [null, /no launcher session record/],
    [session(names, { queue: 'other' }), /session is for queue other/],
    [session(names, { outcome: 'stop', reason: 'SIGTERM during s3' }), /did not complete \(stop: SIGTERM during s3\)/],
    [session(names, { hostBusy: 'kept' }), /HOST-BUSY kept, not released/],
    [session(['s1', 's2']), /session ran s1, s2, not s1, s2, s3/],
    [{ ...session(), jobs: session().jobs.map((j, i) => (i === 1 ? { ...j, exit: 1 } : j)) }, /s2 exited 1/],
    [{ ...session(), jobs: session().jobs.map((j, i) => (i === 2 ? { ...j, confirmations: undefined } : j)) }, /s3: no L3 airflow confirmation/],
    [{ ...session(), jobs: session().jobs.map(j => ({ ...j, confirmations: { airflow: { quote: ' ', date: '2026-11-25' } } })) }, /s1: no L3 airflow confirmation/],
    // An output from another session's queue, pointed at by the queue given to the judge.
    [{ ...session(), jobs: session().jobs.map((j, i) => (i === 0 ? { ...j, out: '/runs/old-s1' } : j)) }, /s1: session output \/runs\/old-s1 is not the judged \/runs\/s1/],
    // A missing or mistyped workload label: the cleanup could not have found the container by it.
    [{ ...session(), jobs: session().jobs.map((j, i) => (i === 1 ? { ...j, workloadLabel: undefined } : j)) }, /s2: workloadLabel \(none\) is not io\.fukulow\.probe=519-final/],
    [{ ...session(), jobs: session().jobs.map((j, i) => (i === 2 ? { ...j, workloadLabel: 'io.fukulow.probe=519' } : j)) }, /s3: workloadLabel io\.fukulow\.probe=519 is not/],
  ];
  for (const [s, pattern] of cases) {
    const v = judge(three(), s, 'q796');
    assert.equal(v.result, 'FAIL', String(pattern));
    assert.match(v.reasons.join('\n'), pattern);
  }
});

test('block problems and a wrong run count FAIL the check', () => {
  const bad = run('s1');
  bad.sends[2] = { ...bad.sends[2], crossed: true, errors: ['latency log'] };
  const r = jr(bad);
  assert.match(r.invalid.join(), /block 3: latency log.*block 3: crossed/);
  assert.match(judge([run('s1'), run('s2')], session(['s1', 's2']), 'q796').reasons.join(), /2 runs, not 3/);
  const five = run('s1');
  five.sends.pop();
  assert.match(jr(five).invalid.join(), /5 blocks, not 6/);
});

test('v3 keeps F6 proc-stat and thermal cadence vetoes while legacy frequency has no vote', async t => {
  const r = run('s1', {}, { ncpu: 16, cpu: () => ({ busy: 0.005, khz: null }) });
  const go = { quote: 'go', date: '2026-11-25' };
  r.metadata = { ...r.metadata, cpuSets: sets796, frequencyStage: 'rehearsal2', frequencyApproval: 'control-digest', frequencyGo: go };
  r.hostAfter = { ...host, launchSession: sid, logicalCpus: 16, policyBoost: { '0': cpus796 },
    ac: [{ supply: 'AC', online: true }], governors: { performance: Array.from({ length: 16 }, (_, cpu) => cpu) },
    updateUnits: [...updateUnits, ...timerServices].map(unit => ({ unit, enabled: 'disabled', active: 'inactive' })),
    sleepUnits: sleepUnits.map(unit => ({ unit, enabled: 'masked', active: 'inactive' })), snapHold: 'absent' };
  r.frequency = { ...evidence, startSession: sid, endSession: sid };
  r.hostAffinity = hostAffinity(sid);
  r.hostAffinityAfter = hostAffinity(sid);
  r.containerCpusets = containerCpusets(sid);
  r.launchCheck = { ...r.launchCheck, frequencyPolicy: evidence.before };
  for (const s of r.sends) {
    s.counters = block(s.order, { launchSession: sid }).counters;
    if (s.measuredWindow && s.pgbenchWindow) s.measuredWindow = { ...s.pgbenchWindow, monoMs: 120_000 };
    s.affinity = [
      { kind: 'client', pid: 10, cpus: sets796.client },
      ...Array.from({ length: 4 }, (_, i) => ({ kind: 'thread', pid: 10 + i, cpus: sets796.client })),
      { kind: 'backend', pid: 20, cpus: sets796.server },
    ];
  }
  const assess = (run: RunInput) => judgeV3(run, { id: sid, thermalSampleSeconds: 5, go }, floors, 'rehearsal2', 'control-digest');
  assert.equal(judgeRun(r, { id: sid, thermalSampleSeconds: 5 }).valid, false);
  assert.deepEqual(assess(r).invalid, []);
  await t.test('v3 requires both same-session host readbacks and both container cpusets', () => {
    assert.match(assess({ ...r, hostAffinity: undefined }).invalid.join(), /start: missing housekeeping readback/);
    assert.match(assess({ ...r, hostAffinity: { ...hostAffinity(sid), workqueue: cpus796 } }).invalid.join(), /start:.*workqueue cpumask/);
    assert.match(assess({ ...r, hostAffinityAfter: undefined }).invalid.join(), /finish: missing housekeeping readback/);
    assert.match(assess({ ...r, hostAffinityAfter: hostAffinity('earlier-session') }).invalid.join(), /finish: missing housekeeping readback/);
    assert.match(assess({ ...r, hostAffinityAfter: { ...hostAffinity(sid), workqueue: cpus796 } }).invalid.join(), /finish:.*workqueue cpumask/);
    assert.match(assess({ ...r, containerCpusets: undefined }).invalid.join(), /missing frequency-container-cpusets\.json/);
    assert.match(assess({ ...r, containerCpusets: containerCpusets('earlier-session') }).invalid.join(), /missing frequency-container-cpusets\.json/);
    const wrong = containerCpusets(sid);
    wrong.client.effective = sets796.server;
    assert.match(assess({ ...r, containerCpusets: wrong }).invalid.join(), /client container effective cpuset/);
    wrong.client.effective = [...sets796.client];
    wrong.client.cgroup = wrong.server.cgroup;
    assert.match(assess({ ...r, containerCpusets: wrong }).invalid.join(), /server and client share a Docker scope/);
    wrong.client.cgroup = wrong.server.cgroup.replace('fukulow796.slice', 'fukulow796xslice');
    assert.match(assess({ ...r, containerCpusets: wrong }).invalid.join(), /client container is outside fukulow796.slice/);
  });
  assert.deepEqual(limits, { tpsSpread: 0.05, walSpread: 0.02, throttle: 0.05 });
  const changed = structuredClone(r);
  const tick = changed.samples.find(s => s.at === new Date(t0 + 90_000).toISOString());
  if (!tick || !('procStat' in tick) || !tick.procStat?.[13]) throw new Error('missing fixture tick');
  tick.procStat[13][4] = 1;
  assert.match(assess(changed).invalid.join(), /F6.*failed thermal samples/);
  const gap = { ...r, samples: r.samples.filter(s => s.at !== new Date(t0 + 90_000).toISOString()) };
  assert.match(assess(gap).invalid.join(), /missing 5 s thermal tick/);
  await t.test('v3 requires affinity evidence only in Rehearsal 2', () => {
    const noAffinity = structuredClone(r);
    delete noAffinity.sends[0].affinity;
    assert.match(assess(noAffinity).invalid.join(), /block 1:.*CPU masks missing or incorrect/);
    noAffinity.metadata.frequencyStage = 'formal';
    assert.deepEqual(judgeV3(noAffinity, { id: sid, thermalSampleSeconds: 5, go }, floors, 'formal', 'control-digest').invalid, []);
  });
  await t.test('F2 uses the same v3 checks across all sixteen blocks', () => {
    const order = f2Order.flat();
    const fixture = run('s1', {}, { ncpu: 16, armOrder: order });
    const comparison: RunInput = { ...r, samples: fixture.samples, sends: fixture.sends,
      metadata: { ...r.metadata, frequencyStage: 'formal' } };
    for (const send of comparison.sends) {
      send.counters = block(send.order, { launchSession: sid }).counters;
      if (send.pgbenchWindow) send.measuredWindow = { ...send.pgbenchWindow, monoMs: 120_000 };
    }
    const bound = { id: sid, thermalSampleSeconds: 5, go };
    const assessF2 = () => judgeV3(comparison, bound, floors, 'formal', 'control-digest', order);
    assert.deepEqual(assessF2().invalid, []);
    assert.ok(judgeV3(comparison, bound, floors, 'formal', 'control-digest').invalid.includes('16 blocks, not 6'));
    const last = comparison.sends.at(-1)!;
    last.arm = 'f2';
    const missedTick = new Date(last.pgbenchWindow!.endMs - 20_000).toISOString();
    comparison.samples = comparison.samples.filter(s => s.at !== missedTick);
    assert.ok(assessF2().invalid.includes('incorrect send arm order'));
    assert.match(assessF2().invalid.join(), /block 16: missing 5 s thermal tick/);
  });
});
