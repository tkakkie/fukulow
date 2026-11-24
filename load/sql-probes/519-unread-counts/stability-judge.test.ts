import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostRecord } from '../../harness-core/host-record.ts';
import type { SampleLine } from '../../harness-core/thermal.ts';
import type { Session } from '../../launcher/launcher.ts';
import { judge, judgeRun, sessionProblems, type RunInput } from './stability-judge.ts';

const t0 = Date.parse('2026-11-25T00:00:00Z');
const host = { platform: 'linux', logicalCpus: 4, boost: '0', policyBoost: { 0: [0, 1, 2, 3] }, platformProfile: 'performance', fanControl: { 'hp/pwm1_enable': 0 } } as unknown as HostRecord;
const arms = ['current', 'final', 'final', 'current', 'current', 'final'];
const idle = () => ({ busy: false, otherContainers: [] as string[] });
const airflow = { airflow: { quote: '蓋を開けて台に載せた', date: '2026-11-25' } };
const sid = 'L1';
const session = (names = ['s1', 's2', 's3'], over: Partial<Session> = {}): Session => ({ id: sid, queue: 'q796', outcome: 'done', hostBusy: 'released', workloadProblems: [],
  finished: '2026-11-25T03:00:00Z', jobs: names.map(name => ({ name, exit: 0, out: '/runs/' + name, workloadLabel: 'io.fukulow.probe=519-final', thermalSampleSeconds: 5, confirmations: airflow })), ...over });
const jr = (r: RunInput, thermalSampleSeconds: unknown = 5) => judgeRun(r, { id: sid, thermalSampleSeconds });

// Six 120 s pgbench intervals ending 200 s apart, each inside a slightly longer run wrapper, sampled
// every 5 s; freq(block) gives the server and client kHz.
function run(name: string, over: Partial<RunInput> = {}, opts: { tps?: number; wal?: number; freq?: (block: number) => [number, number]; periodMs?: number } = {}): RunInput {
  const freq = opts.freq ?? (() => [2_000_000, 2_000_000]);
  const sends = arms.map((arm, i) => {
    const endMs = t0 + (i + 1) * 200_000;
    return { order: i + 1, arm, tps: (opts.tps ?? 10_000) + i, walBytesPerSend: opts.wal ?? 1787, crossed: false, errors: [] as string[],
      measuredWindow: { startMs: endMs - 121_200, endMs: endMs + 300, monoMs: 121_500 }, pgbenchWindow: { startMs: endMs - 120_000, endMs }, host: idle(), hostAfter: idle() };
  });
  const samples: SampleLine[] = [];
  for (let ms = 0; ms <= 1_300_000; ms += opts.periodMs ?? 5000) {
    const block = Math.min(6, Math.max(1, Math.ceil(ms / 200_000)));
    const [server, client] = freq(block);
    samples.push({ at: new Date(t0 + ms).toISOString(), monoMs: ms, avgFreqKHz: [server, client, server, client], temperaturesC: { 'k10temp/Tctl': 70 }, fansRpm: {}, launchSession: sid });
  }
  return { name, out: '/runs/' + name, complete: true, statusSession: sid, sends,
    metadata: { mode: 'diagnostic', sendsOnly: true, launchSession: sid, cpuSets: { server: [0, 2], client: [1, 3] }, sends: { measuredSeconds: 120 } },
    hostBefore: { ...host, launchSession: sid }, cooldown: { ok: true, maxTctlC: 50, maxWaitSeconds: 1200, readings: [{ elapsedMs: 30_000, tctlC: 49 }], launchSession: sid },
    launchCheck: { ok: true, tctlC: 48, record: host, launchSession: sid }, samples, ...over };
}
const three = () => [run('s1'), run('s2', {}, { tps: 10_200 }), run('s3', {}, { tps: 10_400 })];

test('three valid runs of one completed session inside both spreads PASS', () => {
  const v = judge(three(), session(), 'q796');
  assert.deepEqual([v.result, v.reasons], ['PASS', []]);
  assert.deepEqual([v.runs[0].blocks[0].thermal.samples, v.runs[0].blocks[0].thermal.maxGapMs], [23, 5000]); // 1 s guard at each end
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

test('a block more than 5 % below block 1 on either set is throttled: the run is INVALID and the check FAILs', () => {
  const r = jr(run('s1', {}, { freq: b => [b === 5 ? 1_890_000 : 2_000_000, 2_000_000] }));
  assert.equal(r.valid, false);
  assert.match(r.invalid.join(), /block 5: throttled, server median 1890000 kHz < 95 % of block 1/);
  assert.equal(jr(run('s1', {}, { freq: b => [2_000_000, b === 6 ? 1_899_999 : 2_000_000] })).invalid.length, 1);
  assert.equal(jr(run('s1', {}, { freq: b => [b === 3 ? 1_900_000 : 2_000_000, 2_000_000] })).valid, true); // exactly 5 % is not throttled
  assert.equal(judge([run('s1', {}, { freq: b => [b > 3 ? 1_000_000 : 2_000_000, 2_000_000] }), run('s2'), run('s3')], session(), 'q796').result, 'FAIL');
});

const setFreq = (r: RunInput, from: number, to: number, khz: number) => {
  for (const x of r.samples as { at: string; monoMs: number; avgFreqKHz: number[] }[]) if (x.monoMs >= from && x.monoMs <= to) x.avgFreqKHz = [khz, 2_000_000, khz, 2_000_000];
};

test('the block is judged on pgbench\'s own interval, not on the run wrapper around it', () => {
  // Block 5: pgbench ran 881-1000 s; its guarded ticks (885-995 s) are 13 at 1.78 GHz and 10 at
  // 2.00 GHz: throttled. Its run wrapper (869.8-1011 s) adds 2.00 GHz start-up and teardown ticks,
  // which as the window would lift the median to 2.00 GHz.
  const r = run('s1');
  setFreq(r, 885_000, 945_000, 1_780_000);
  r.sends[4].measuredWindow = { startMs: t0 + 869_800, endMs: t0 + 1_011_000, monoMs: 141_200 };
  r.sends[4].pgbenchWindow = { startMs: t0 + 881_000, endMs: t0 + 1_000_000 };
  const j = jr(r);
  assert.deepEqual(j.invalid, ['block 5: throttled, server median 1780000 kHz < 95 % of block 1 (2000000 kHz)']);
  assert.equal(j.blocks[4].thermal.samples, 23);
  // A healthy run with 11 s of Docker and connection overhead around the 120 s is not rejected.
  const slowStart = run('s1');
  slowStart.sends[0].measuredWindow = { startMs: t0 + 69_000, endMs: t0 + 200_500, monoMs: 131_500 };
  assert.deepEqual(jr(slowStart).invalid, []);
});

test('an undetected sub-second clock step cannot pull an outside tick into the window', () => {
  // pgbench ran 880.5-1000.5 s (its log stamps on its start-time offset). The wall clock then stepped
  // +0.9 s, so the sampler's ticks from 880 s on are stamped 0.9 s late: the 2.00 GHz tick taken 0.5 s
  // before pgbench started is stamped inside its window. 12 of the 24 ticks taken during pgbench run
  // at 1.85 GHz. Without the 1 s guard the outside tick makes the median 1.925 GHz (not throttled);
  // with it the 23 ticks counted all ran during pgbench and the median is 1.85 GHz (throttled).
  const r = run('s1');
  setFreq(r, 885_000, 940_000, 1_850_000);
  for (const x of r.samples as { at: string; monoMs: number }[]) if (x.monoMs >= 880_000) x.at = new Date(t0 + x.monoMs + 900).toISOString();
  r.sends[4].pgbenchWindow = { startMs: t0 + 880_500, endMs: t0 + 1_000_500 };
  r.sends[4].measuredWindow = { startMs: t0 + 879_000, endMs: t0 + 1_001_000, monoMs: 122_000 };
  const j = jr(r);
  assert.deepEqual(j.invalid, ['block 5: throttled, server median 1850000 kHz < 95 % of block 1 (2000000 kHz)']);
  // A larger step along a block's ticks is caught by the sampler's own monotonic stamps.
  const stepped = run('s1');
  for (const x of stepped.samples as { at: string; monoMs: number }[]) if (x.monoMs >= 950_000) x.at = new Date(t0 + x.monoMs + 1500).toISOString();
  assert.match(jr(stepped).invalid.join('\n'), /block 5: wall clock stepped against the sampler's monotonic clock \(1500 ms\)/);
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
  // Every gap 5.4 s is within the per-tick lateness, but a block then has too few ticks.
  const slow = jr(run('s1', {}, { periodMs: 5400 }));
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
  assert.match(jr(failedTick).invalid.join(), /block 1: 1 failed thermal samples.*block 1: unreadable CPU frequency/);
  const missing = run('s1');
  missing.samples.splice(20, 1);
  const r = jr(missing);
  assert.deepEqual(r.invalid, ['block 1: missing 5 s thermal tick (gap 10000 ms)', 'block 1: 22 thermal ticks, fewer than the 23 of a 5 s cadence']);
  const torn = run('s1');
  torn.samples.push({ at: null, error: 'unparseable line' });
  assert.match(jr(torn).invalid.join(), /1 thermal lines without a time/);
  const unreadable = run('s1');
  unreadable.samples[30] = { ...unreadable.samples[30], avgFreqKHz: [null, 1, 1, 1] } as SampleLine;
  assert.match(jr(unreadable).invalid.join(), /unreadable CPU frequency/);
});

test('a missing lever, cool-down, launch check, procedure or thermal record makes the run INVALID', () => {
  const cases: [Partial<RunInput>, RegExp][] = [
    [{ hostBefore: { ...host, boost: '1' } as HostRecord }, /lever: boost is 1/],
    [{ hostBefore: { ...host, policyBoost: { 0: [0, 1], 1: [2, 3] } } as unknown as HostRecord }, /lever: per-CPU boost is not 0 on every CPU/],
    [{ hostBefore: { ...host, fanControl: { 'hp/pwm1_enable': 2 } } as HostRecord }, /lever: fan control/],
    [{ hostBefore: { ...host, platformProfile: 'balanced' } as HostRecord }, /lever: platform profile/],
    [{ hostBefore: null }, /no host record/],
    [{ cooldown: null }, /no passed cool-down/],
    [{ cooldown: { ok: true, maxTctlC: 60, maxWaitSeconds: 1200 } }, /no passed cool-down/],
    [{ launchCheck: null }, /no passed launch check/],
    [{ launchCheck: { ok: true, tctlC: 51, record: host } }, /no passed launch check/],
    [{ launchCheck: { ok: true, tctlC: 45, record: { ...host, boost: '1' } as HostRecord } }, /lever at launch: boost is 1/],
    [{ samples: [] }, /block 1: missing 5 s thermal tick \(gap Infinity ms\)/],
    [{ metadata: { mode: 'diagnostic', sendsOnly: true, cpuSets: null, sends: { measuredSeconds: 120 } } }, /no CPU sets/],
    [{ metadata: { mode: 'diagnostic', sendsOnly: false, cpuSets: { server: [0, 2], client: [1, 3] }, sends: { measuredSeconds: 120 } } }, /not the #519 send diagnosis/],
    [{ metadata: { mode: 'smoke', sendsOnly: true, cpuSets: { server: [0, 2], client: [1, 3] }, sends: { measuredSeconds: 120 } } }, /not the #519 send diagnosis/],
    [{ complete: false }, /did not complete/],
  ];
  for (const [over, pattern] of cases) {
    const r = jr(run('s1', over));
    assert.equal(r.valid, false, String(pattern));
    assert.match(r.invalid.join('\n'), pattern);
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
