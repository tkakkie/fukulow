import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { outsideCheckout } from '../harness-core/checkout.ts';
import { modeOf, stages } from '../harness-core/stages.ts';
import { formatHostBusy, parseHostBusy } from '../launcher/host-busy.ts';
import { stack } from './stack.ts';
import { minimumSamples, readSamples, summarize, type Sample } from './summary.ts';
import { trafficProfile, verifyTraffic, waitForTraffic } from './traffic.ts';

const { values } = parseArgs({ options: {
  out: { type: 'string' }, smoke: { type: 'boolean' }, rehearsal: { type: 'boolean' }, recorded: { type: 'boolean' },
} });
const mode = modeOf(values);
const smoke = mode === 'smoke';
const out = values.out;
if (!out || !isAbsolute(out) || !outsideCheckout(out, process.cwd(), 'resolve')) {
  throw new Error('--out must be an absolute path outside the checkout');
}
const runId = process.env.FUKULOW_LAUNCH_SESSION ?? randomUUID();
const macBusy = join(homedir(), 'dev', 'fukulow', 'runs', 'HOST-BUSY');
if (smoke) {
  if (process.platform !== 'darwin') throw new Error('--smoke is for the development Mac');
} else {
  const busy = process.env.FUKULOW_HOST_BUSY;
  const claim = busy && parseHostBusy(readFileSync(busy, 'utf8'));
  if (process.platform !== 'linux' || !claim || claim.session !== runId ||
      !claim.jobs.includes(process.env.FUKULOW_LAUNCH_JOB ?? '')) {
    throw new Error('Run full-size rehearsal and recorded mode through load/launch.ts on Ubuntu');
  }
}

const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => stop.abort(new Error(signal)));
}
const claim = formatHostBusy('1066-mac-smoke', ['1066-smoke'], new Date(), runId);
if (smoke) writeFileSync(macBusy, claim, { flag: 'wx' });

try {
  mkdirSync(out, { mode: 0o700 });
} catch (error) {
  if (smoke) rmSync(macBusy);
  throw error;
}
const progress = stages(out, mode, runId);
const profile = trafficProfile(smoke);
const samplesPerState = smoke ? 20 : minimumSamples;
const workload = stack(out, profile, !smoke, stop.signal);
const rows: Record<'idle' | 'loaded', Sample[]> = { idle: [], loaded: [] };
const problems: string[] = [];
let placement: Awaited<ReturnType<typeof workload.start>> = null;
let trafficPin: number[] | null = null;
let traffic: ReturnType<typeof verifyTraffic> | undefined;
let trafficDone: Promise<number | null> | undefined;
let cleaned = false;

async function sample(state: keyof typeof rows) {
  progress.enter(state);
  const code = await workload.sample(state, samplesPerState);
  rows[state] = readSamples(readFileSync(join(out!, `${state}.jsonl`), 'utf8'));
  if (rows[state].length) progress.startSampling();
  if (code !== 0 || rows[state].length !== samplesPerState || rows[state].some(row => !row.ok)) {
    throw new Error(`${state} sampler failed or returned incomplete samples. See sampler.log`);
  }
  progress.done(state);
}

try {
  progress.enter('compose setup');
  placement = await workload.start();
  progress.done('compose setup');
  await sample('idle');
  progress.enter('k6 warmup');
  trafficDone = workload.startTraffic();
  const log = join(out, 'traffic.log');
  await waitForTraffic(log, trafficDone, stop.signal);
  trafficPin = await workload.trafficPin();
  await sample('loaded');
  if (await trafficDone !== 0) throw new Error('k6 failed. See traffic.log');
  traffic = verifyTraffic(log, rows.loaded, profile);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
  stop.abort();
} finally {
  await trafficDone;
  try {
    await workload.down();
    cleaned = true;
  } catch {
    problems.push('Compose cleanup failed');
  }
  if (smoke && cleaned && readFileSync(macBusy, 'utf8') === claim) rmSync(macBusy);
}

const verdict = summarize(rows.idle, rows.loaded, problems);
const summary = {
  mode, runId, samplesPerState, client: 'app container to db:5432 over the Compose backend network',
  load: { script: 'load/scenario.ts', profile, ...traffic },
  placement: placement && { ...placement, traffic: trafficPin },
  ...verdict,
};
const ms = (value: number | null) => value?.toFixed(6) ?? '—';
const markdown = [
  `# #1066 fresh connection setup (${mode})`, '',
  `Verdict **${summary.verdict}**. Readiness acquisition bound **${summary.readinessBoundMs} ms**.`, '',
  '| State | Samples | p50 ms | p99 ms | p99.9 ms | Max ms | At or above bound |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...Object.entries(summary.states).map(([state, s]) =>
    `| ${state} | ${s.samples} | ${ms(s.p50Ms)} | ${ms(s.p99Ms)} | ${ms(s.p999Ms)} | ${ms(s.maxMs)} | ${s.atOrAboveReadinessBound} |`),
  '', ...summary.reasons.map(reason => `- ${reason}`), '',
].join('\n');
const failed = problems.length > 0 || (!smoke && summary.verdict === 'INVALID');
const status = progress.finish(() => {
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(out, 'result.md'), markdown);
}, { failed, interrupted: stop.signal.reason instanceof Error && /^(SIGINT|SIGTERM|SIGHUP)$/.test(stop.signal.reason.message),
  invalidEvidence: summary.verdict === 'INVALID', summaryInvalidates: true });
console.log(markdown);
if (status.outcome !== 'success') process.exitCode = 3;
