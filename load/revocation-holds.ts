// #668 session entry point. The maintainer approves rehearsal and formal runs separately.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { resolve } from 'node:path';
import { outsideCheckout } from './proxy-target.ts';
import { THRESHOLDS } from './revocation-burst-judgment.ts';
import { judgeHolds, passBarEvidence, verdictByCell } from './revocation-holds-judgment.ts';
import { memoryEntry, type RssCorrectionKb } from './revocation-holds-memory.ts';
import { formalMemoryVerdicts, memoryWithInclusions, type AttemptMemory } from './revocation-holds-memory-inclusions.ts';
import { noticeCorrectness } from './revocation-holds-notices.ts';
import { overheadCorrection, overheadPlan, overheadReport, overheadSample } from './revocation-holds-overhead.ts';
import { Q2_TRIGGER, rehearsalCounts } from './revocation-holds-rehearsal.ts';
import { CELLS, DURATIONS, parseOptions, planRuns, replacementQueue, runId, setupQueue, TIMELINE } from './revocation-holds-plan.ts';
import { cleanup, measure, type Active } from './revocation-holds-run.ts';
import { SetupAbort, type Setup } from './revocation-holds-setup.ts';
import { clientScope, placementEnabled } from './revocation-holds-placement.ts';
import { preflightLedgerPath, recordPreflight, requireRecordedLedger } from './revocation-holds-preflight-ledger.ts';
import { preflightSession } from './revocation-holds-preflight-session.ts';
import { collectSessionIdentity, type SessionIdentity } from './revocation-holds-provenance.ts';

const checkout = resolve(import.meta.dirname, '..');
const binary = resolve(checkout, 'target/release/fukulow-server');
const helperBinary = resolve(process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname, 'harness-core/stall-helper/target'), 'release/fukulow-stall-helper');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  const node = 'mise exec node@26.13.1 -- node load/revocation-holds.ts';
  console.log([
    'Build the helper with cargo build --release --locked --manifest-path load/harness-core/stall-helper/Cargo.toml.',
    'On Linux, the maintainer installs the #796 scope rule once with sudo "$(command -v node)" load/harness-core/boot-796.ts install --measurement-user USER.',
    'Linux launch as the measurement user',
    `  ${clientScope('$$').join(' ')} bash -ic 'ulimit -n 65536; exec ${node} "$@"' bash <options>`,
    `macOS local preflight and rehearsal: bash -ic 'ulimit -n 65536; exec ${node} "$@"' bash <options>`,
    'Options for preflight: --out /absolute/new/dir --preflight [--session ID]',
    'Options after preflight: --out /absolute/new/dir --preflight-result /absolute/path/preflight.json [--session ID]',
    '  [--rehearsal | --overhead | --overhead-summary <summary.json>] [--cells ...] [--durations short,long]',
    'Use a clean checkout and the same server and stall-helper binaries on the same boot.',
    'Every stage uses one host ledger: by default ${XDG_STATE_HOME:-$HOME/.local/state}/fukulow/revocation-holds-preflights.<hostname>.ndjson, or --preflight-ledger /absolute/path. A later stage refuses a ledger other than the one its preflight.json records.',
    'Use FUKULOW_LAUNCH_SESSION or choose a fresh --session ID for each measurement session.',
  ].join('\n'));
  process.exit(0);
}
const value = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const val = args[i + 1];
  if (!val?.trim() || val.startsWith('--')) throw new Error(`${name} requires a value`);
  return val;
};
const preflight = args.includes('--preflight');
const overhead = args.includes('--overhead');
const fixedOptions = new Set(['--out', '--session', '--preflight-result', '--preflight-ledger']);
if ((preflight || overhead) && args.some(arg => arg.startsWith('--') &&
  !fixedOptions.has(arg) && arg !== (preflight ? '--preflight' : '--overhead'))) {
  throw new Error('Preflight and overhead use fixed Hcap plans');
}
const explicitSession = value('--session');
const launchSession = process.env.FUKULOW_LAUNCH_SESSION;
if (launchSession && explicitSession && launchSession !== explicitSession) throw new Error('--session must match FUKULOW_LAUNCH_SESSION');
const session = launchSession || explicitSession || '';
if (preflight && (!session || args.includes('--preflight-result'))) throw new Error('Preflight needs a session ID and writes its own preflight.json');
const preflightFile = value('--preflight-result');
const options = parseOptions(overhead ? [...args, '--rehearsal'] : args);
const mode = preflight ? 'preflight' : overhead ? 'overhead' : options.rehearsal ? 'rehearsal' : 'formal';
const host = hostname();
const ledger = outsideCheckout(preflightLedgerPath(host, value('--preflight-ledger')));
const hostLedger = outsideCheckout(preflightLedgerPath(host));
// Refused before anything else, including the Linux placement check, so every later stage fails the same way.
if (preflightFile) requireRecordedLedger(preflightFile, ledger);
const linuxPlacement = placementEnabled(platform(), mode);
const output = outsideCheckout(options.out);
if (existsSync(output)) throw new Error('Output directory already exists');
mkdirSync(output, { recursive: true });

const active: Active = {};
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (interrupted) return;
  interrupted = true;
  void cleanup(active).then(() => process.exit(130));
});
const readIdentity = async () => {
  if (process.version !== 'v26.13.1') throw new Error('Use Node 26.13.1');
  if (!existsSync(binary)) throw new Error('Build the release server first: cargo build --release --locked -p fukulow-server');
  const identity = await collectSessionIdentity({ session, checkout, binary, helperBinary });
  if (interrupted) throw new Error('Measurement interrupted');
  return identity;
};
const environmentFor = (identity: SessionIdentity, correctionKb?: RssCorrectionKb) => ({
  ...identity, mode, linuxPlacement, preflightFile, preflightLedger: ledger,
  cells: CELLS, durations: DURATIONS, timeline: TIMELINE, stall: options.stall, thresholds: THRESHOLDS,
  ...(mode === 'formal' ? { overheadCorrectionKb: correctionKb ?? null } : {}),
});
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2));
const contextFor = (setup: Setup) => ({
  binary, helperBinary, output, stall: options.stall, active, interrupted: () => interrupted, setup, linuxPlacement,
});
const runAttempt: typeof measure = async (...args) => {
  try { return await measure(...args); }
  catch (error) { await cleanup(active); throw error; }
};

async function runLaterStage() {
  const identity = await readIdentity();
  const correctionKb = options.overheadSummary
    ? overheadCorrection(JSON.parse(readFileSync(options.overheadSummary, 'utf8')))
    : undefined;
  const environment = environmentFor(identity, correctionKb);
  save('environment.json', environment);
  const context = contextFor({ kind: 'measured', identity, ledger, hostLedger, preflightFile });
  if (overhead) {
    const samples: ReturnType<typeof overheadSample>[] = [];
    const errors: { id: string; message: string }[] = [];
    const setupAborts: typeof errors = [];
    const queue = setupQueue(overheadPlan().flatMap(({ mode, runs }) => runs.map(planned => ({ mode, planned }))), slot => runId(slot.planned));
    for (const { run: { mode, planned }, id } of queue.attempts()) {
      console.log(`#668 ${id} trace ${mode}`);
      try { samples.push(overheadSample(await runAttempt({ ...context, overhead: mode }, planned, id), mode)); }
      catch (error) {
        const entry = { id, message: (error as Error).message };
        if (error instanceof SetupAbort) {
          setupAborts.push(entry);
          if (!queue.abort()) process.exitCode = 1;
        } else errors.push(entry);
      }
      save('summary.json', { environment, overhead: overheadReport(samples), errors, setupAborts });
    }
    const report = overheadReport(samples);
    console.log(JSON.stringify({ withinBounds: report.withinBounds, timing: report.timing, rss: report.rss, errors, setupAborts }));
  } else {
    const queue = replacementQueue(planRuns(options.cells, options.durations, options.repeats, options.controls));
    const results: ({ id: string; kind: 'fault' | 'control'; cell: keyof typeof CELLS; duration?: keyof typeof DURATIONS; repeat: number } &
      (ReturnType<typeof judgeHolds> | { verdict: 'INVALID'; floorReasons: string[]; reasons: string[] }) &
      { correctness?: ReturnType<typeof noticeCorrectness>['details'] })[] = [];
    const setupAborts: { id: string; message: string }[] = [];
    const memory: AttemptMemory[] = [];
    let history = memoryWithInclusions(memory);
    let stopped: string | undefined;
    const rehearsal: { id: string; counts?: ReturnType<typeof rehearsalCounts>; error?: string }[] = [];
    const q2Runs: string[] = [];
    for (const { run: planned, id } of queue.attempts()) {
      const base = { id, kind: planned.kind, cell: planned.cell, duration: planned.kind === 'fault' ? planned.duration : undefined, repeat: planned.repeat };
      console.log(`#668 ${id}`);
      let run: Awaited<ReturnType<typeof measure>> | undefined;
      let error: unknown;
      try { run = await runAttempt(context, planned, id); }
      catch (failure) { error = failure; }
      if (error instanceof SetupAbort) {
        setupAborts.push({ id, message: error.message });
        console.log(`#668 ${id} setup aborted: ${error.message}`);
        if (!queue.record(planned, 'setup abort')) {
          stopped = `two consecutive setup aborts for ${runId(planned)}`;
          process.exitCode = 1;
        }
      }
      if (options.rehearsal) {
        if (!(error instanceof SetupAbort)) {
          const counts = run && rehearsalCounts(run);
          rehearsal.push(counts ? { id, counts } : { id, error: (error as Error).message });
          if (counts?.q2Trigger) { q2Runs.push(id); console.log(counts.q2Trigger); }
          console.log(JSON.stringify(rehearsal.at(-1)));
        }
        save('rehearsal.json', rehearsal);
        save('summary.json', { environment, q2Trigger: q2Runs.length ? Q2_TRIGGER : undefined, q2Runs, rehearsal, setupAborts, stopped });
        if (stopped) break;
        continue;
      }
      if (run) {
        const judged = judgeHolds(run);
        const correctness = run.kind === 'fault' ? noticeCorrectness(run).details : undefined;
        results.push({ ...base, ...judged, correctness });
        if (judged.evidence.q2AdmissionReview) { q2Runs.push(id); console.log(Q2_TRIGGER); }
        memory.push({ ...memoryEntry(run, judged.verdict, judged.floors.hwmLowest), id, evidenceOnly: judged.evidenceOnly });
        history = memoryWithInclusions(memory, history);
        queue.record(planned, judged.verdict);
        console.log(JSON.stringify({ id, verdict: judged.verdict, floorReasons: judged.floorReasons, reasons: judged.reasons, evidence: judged.evidence.issues }));
      } else if (!(error instanceof SetupAbort)) {
        results.push({ ...base, verdict: 'INVALID', floorReasons: [`run did not complete: ${(error as Error).message}`], reasons: [] });
        queue.record(planned, 'INVALID');
      }
      save('results.json', results);
      const memoryFailures = Object.fromEntries(Object.entries(history).map(([key, group]) => [key, group.failures]));
      save('summary.json', {
        environment, q2Trigger: q2Runs.length ? Q2_TRIGGER : undefined, q2Runs, byCell: verdictByCell(results), passBars: passBarEvidence(results),
        memory: formalMemoryVerdicts(history, correctionKb), memoryFailures, results, setupAborts, stopped,
      });
      if (stopped) break;
    }
  }
}

try {
  if (preflight) {
    const result = await recordPreflight(ledger, output, { hostname: host, session }, readIdentity, (identity, saveProgress) => {
      save('environment.json', environmentFor(identity));
      const context = contextFor({ kind: 'preflight' });
      return preflightSession(identity, (trial, id) => {
        console.log(`#668 preflight ${id}`);
        return runAttempt({ ...context, preflightVolume: trial.volume }, trial.run, id);
      }, saveProgress);
    }, hostLedger);
    console.log(`#668 preflight ${result.passed ? 'passed' : 'failed'}`);
    if (!result.passed) process.exitCode = 1;
  } else await runLaterStage();
} finally {
  await cleanup(active);
}
