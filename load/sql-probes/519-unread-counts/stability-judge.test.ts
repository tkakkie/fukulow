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
const session = (names = ['s1', 's2', 's3'], over: Partial<Session> = {}): Session => ({ queue: 'q796', outcome: 'done', hostBusy: 'released', workloadProblems: [],
  finished: '2026-11-25T03:00:00Z', jobs: names.map(name => ({ name, exit: 0, confirmations: airflow })), ...over });

// Six 120 s measured windows ending 200 s apart, sampled every 5 s; freq(block) gives the server and client kHz.
function run(name: string, over: Partial<RunInput> = {}, opts: { tps?: number; wal?: number; freq?: (block: number) => [number, number] } = {}): RunInput {
  const freq = opts.freq ?? (() => [2_000_000, 2_000_000]);
  const sends = arms.map((arm, i) => {
    const endMs = t0 + (i + 1) * 200_000;
    return { order: i + 1, arm, tps: (opts.tps ?? 10_000) + i, walBytesPerSend: opts.wal ?? 1787, crossed: false, errors: [] as string[],
      measuredWindow: { startMs: endMs - 120_000, endMs, monoMs: 120_000 }, host: idle(), hostAfter: idle() };
  });
  const samples: SampleLine[] = [];
  for (let s = 0; s <= 1300; s += 5) {
    const block = Math.min(6, Math.max(1, Math.ceil(s / 200)));
    const [server, client] = freq(block);
    samples.push({ at: new Date(t0 + s * 1000).toISOString(), avgFreqKHz: [server, client, server, client], temperaturesC: { 'k10temp/Tctl': 70 }, fansRpm: {} });
  }
  return { name, complete: true, sends, metadata: { mode: 'diagnostic', sendsOnly: true, cpuSets: { server: [0, 2], client: [1, 3] }, sends: { measuredSeconds: 120 } },
    hostBefore: host, cooldown: { ok: true, maxTctlC: 50, maxWaitSeconds: 1200 }, launchCheck: { ok: true, tctlC: 48, record: host },
    samples, thermalSampleSeconds: 5, ...over };
}
const three = () => [run('s1'), run('s2', {}, { tps: 10_200 }), run('s3', {}, { tps: 10_400 })];

test('three valid runs of one completed session inside both spreads PASS', () => {
  const v = judge(three(), session(), 'q796');
  assert.deepEqual([v.result, v.reasons], ['PASS', []]);
  assert.deepEqual([v.runs[0].blocks[0].thermal.samples, v.runs[0].blocks[0].thermal.maxGapMs], [25, 5000]);
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
  const r = judgeRun(run('s1', {}, { freq: b => [b === 5 ? 1_890_000 : 2_000_000, 2_000_000] }));
  assert.equal(r.valid, false);
  assert.match(r.invalid.join(), /block 5: throttled, server median 1890000 kHz < 95 % of block 1/);
  assert.equal(judgeRun(run('s1', {}, { freq: b => [2_000_000, b === 6 ? 1_899_999 : 2_000_000] })).invalid.length, 1);
  assert.equal(judgeRun(run('s1', {}, { freq: b => [b === 3 ? 1_900_000 : 2_000_000, 2_000_000] })).valid, true); // exactly 5 % is not throttled
  assert.equal(judge([run('s1', {}, { freq: b => [b > 3 ? 1_000_000 : 2_000_000, 2_000_000] }), run('s2'), run('s3')], session(), 'q796').result, 'FAIL');
});

test('the block is judged on its recorded pgbench window, not on its end time', () => {
  // 13 of the 25 ticks in block 5's window at 1.78 GHz: throttled. The judge reads the recorded
  // window only; a block without one is INVALID instead of judged on a window derived from its end.
  const slow = (r: RunInput) => { for (const s of r.samples as { at: string; avgFreqKHz: number[] }[]) {
    const t = Date.parse(s.at) - t0; if (t >= 880_000 && t < 945_000) s.avgFreqKHz = [1_780_000, 2_000_000, 1_780_000, 2_000_000];
  } return r; };
  assert.match(judgeRun(slow(run('s1'))).invalid.join(), /block 5: throttled, server median 1780000/);
  const noWindow = run('s1');
  delete noWindow.sends[4].measuredWindow;
  assert.match(judgeRun(slow(noWindow)).invalid.join(), /block 5: no measured window/);
  const stepped = run('s1');
  stepped.sends[1].measuredWindow = { ...stepped.sends[1].measuredWindow!, monoMs: 118_000 };
  assert.match(judgeRun(stepped).invalid.join(), /block 2: wall clock stepped .*block 2: measured window 118000 ms is not 120 s/);
  const long = run('s1');
  long.sends[0].measuredWindow = { startMs: t0 + 60_000, endMs: t0 + 200_000, monoMs: 140_000 };
  assert.match(judgeRun(long).invalid.join(), /block 1: measured window 140000 ms is not 120 s \(\+10 s\)/);
});

test('a failed, missing or torn thermal tick in a block makes the run INVALID (no allowance)', () => {
  const failedTick = run('s1');
  failedTick.samples[20] = { at: failedTick.samples[20].at, error: 'EIO' }; // 100 s, inside block 1
  assert.match(judgeRun(failedTick).invalid.join(), /block 1: 1 failed thermal samples.*block 1: unreadable CPU frequency/);
  const missing = run('s1');
  missing.samples.splice(20, 1);
  const r = judgeRun(missing);
  assert.deepEqual(r.invalid, ['block 1: missing 5 s thermal tick (gap 10000 ms)']);
  const torn = run('s1');
  torn.samples.push({ at: null, error: 'unparseable line' });
  assert.match(judgeRun(torn).invalid.join(), /1 thermal lines without a time/);
  const unreadable = run('s1');
  unreadable.samples[30] = { ...unreadable.samples[30], avgFreqKHz: [null, 1, 1, 1] } as SampleLine;
  assert.match(judgeRun(unreadable).invalid.join(), /unreadable CPU frequency/);
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
    [{ thermalSampleSeconds: undefined }, /thermal samples every \(none\) s/],
    [{ samples: [] }, /block 1: missing 5 s thermal tick \(gap Infinity ms\)/],
    [{ metadata: { mode: 'diagnostic', sendsOnly: true, cpuSets: null, sends: { measuredSeconds: 120 } } }, /no CPU sets/],
    [{ metadata: { mode: 'diagnostic', sendsOnly: false, cpuSets: { server: [0, 2], client: [1, 3] }, sends: { measuredSeconds: 120 } } }, /not the #519 send diagnosis/],
    [{ metadata: { mode: 'smoke', sendsOnly: true, cpuSets: { server: [0, 2], client: [1, 3] }, sends: { measuredSeconds: 120 } } }, /not the #519 send diagnosis/],
    [{ complete: false }, /did not complete/],
  ];
  for (const [over, pattern] of cases) {
    const r = judgeRun(run('s1', over));
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
    const j = judgeRun(r);
    assert.deepEqual([j.valid, j.invalid.length], [false, 1], String(pattern));
    assert.match(j.invalid[0], pattern);
  }
});

test('the verdict needs one completed session that ran exactly the three jobs, released HOST-BUSY and recorded L3', () => {
  const names = ['s1', 's2', 's3'];
  assert.deepEqual(sessionProblems(session(), 'q796', names), []);
  const cases: [Session | null, RegExp][] = [
    [null, /no launcher session record/],
    [session(names, { queue: 'other' }), /session is for queue other/],
    [session(names, { outcome: 'stop', reason: 'SIGTERM during s3' }), /did not complete \(stop: SIGTERM during s3\)/],
    [session(names, { hostBusy: 'kept' }), /HOST-BUSY kept, not released/],
    [session(['s1', 's2']), /session ran s1, s2, not s1, s2, s3/],
    [{ ...session(), jobs: session().jobs.map((j, i) => (i === 1 ? { ...j, exit: 1 } : j)) }, /s2 exited 1/],
    [{ ...session(), jobs: session().jobs.map((j, i) => (i === 2 ? { ...j, confirmations: undefined } : j)) }, /s3: no L3 airflow confirmation/],
    [{ ...session(), jobs: session().jobs.map(j => ({ ...j, confirmations: { airflow: { quote: ' ', date: '2026-11-25' } } })) }, /s1: no L3 airflow confirmation/],
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
  const r = judgeRun(bad);
  assert.match(r.invalid.join(), /block 3: latency log.*block 3: crossed/);
  assert.match(judge([run('s1'), run('s2')], session(['s1', 's2']), 'q796').reasons.join(), /2 runs, not 3/);
  const five = run('s1');
  five.sends.pop();
  assert.match(judgeRun(five).invalid.join(), /5 blocks, not 6/);
});
