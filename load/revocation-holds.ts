// #668 session entry point. The maintainer approves rehearsal and formal runs separately.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { outsideCheckout } from './proxy-target.ts';
import { THRESHOLDS } from './revocation-burst-judgment.ts';
import { judgeHolds, verdictByCell } from './revocation-holds-judgment.ts';
import { memoryEntry } from './revocation-holds-memory.ts';
import { memoryWithInclusions, type AttemptMemory } from './revocation-holds-memory-inclusions.ts';
import { noticeCorrectness } from './revocation-holds-notices.ts';
import { overheadPlan, overheadReport, overheadSample } from './revocation-holds-overhead.ts';
import { rehearsalCounts } from './revocation-holds-rehearsal.ts';
import { CELLS, DURATIONS, parseOptions, planRuns, replacementQueue, runId, STALL_DEFAULT, TIMELINE } from './revocation-holds-plan.ts';
import { cleanup, measure, SetupAbort, type Active } from './revocation-holds-run.ts';

const checkout = resolve(import.meta.dirname, '..');
const binary = resolve(checkout, 'target/release/fukulow-server');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('ulimit -n 65536; node load/revocation-holds.ts --out /absolute/new/dir [--rehearsal | --overhead] [--cells ...] [--durations short,long]');
  process.exit(0);
}
const overhead = args.includes('--overhead');
const options = parseOptions(overhead ? [...args, '--rehearsal'] : args);
if (overhead && args.some((arg, i) => arg.startsWith('--') && arg !== '--out' && arg !== '--overhead' && args[i - 1] !== '--out')) {
  throw new Error('--overhead uses the registered Hcap plan and takes only --out');
}
const output = outsideCheckout(options.out);
if (existsSync(output)) throw new Error('Output directory already exists');
if (process.version !== 'v26.13.1') throw new Error('Use Node 26.13.1');
if (!existsSync(binary)) throw new Error('Build the release server first: cargo build --release --locked -p fukulow-server');
mkdirSync(output, { recursive: true });

const active: Active = {};
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (interrupted) return;
  interrupted = true;
  void cleanup(active).then(() => process.exit(130));
});
const environment = {
  node: process.version, platform: platform(), arch: arch(), release: release(), cpus: cpus().length, memoryBytes: totalmem(),
  mode: overhead ? 'overhead' : options.rehearsal ? 'rehearsal' : 'formal',
  cells: CELLS, durations: DURATIONS, timeline: TIMELINE, stall: overhead ? STALL_DEFAULT : options.stall, thresholds: THRESHOLDS,
  commit: (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim(),
};
const save = (name: string, value: unknown) => writeFileSync(resolve(output, name), JSON.stringify(value, null, 2));
save('environment.json', environment);
const context = { binary, output, stall: environment.stall, active, interrupted: () => interrupted };

try {
  if (overhead) {
    const samples: ReturnType<typeof overheadSample>[] = [];
    const errors: { id: string; message: string }[] = [];
    for (const { mode, runs } of overheadPlan()) for (const planned of runs) {
      const id = runId(planned);
      console.log(`#668 ${id} trace ${mode}`);
      try { samples.push(overheadSample(await measure({ ...context, overhead: mode }, planned), mode)); }
      catch (error) { errors.push({ id, message: (error as Error).message }); await cleanup(active); }
      save('summary.json', { environment, overhead: overheadReport(samples), errors });
    }
    const report = overheadReport(samples);
    console.log(JSON.stringify({ withinBounds: report.withinBounds, timing: report.timing, rss: report.rss, errors }));
  } else {
    const queue = replacementQueue(planRuns(options.cells, options.durations, options.repeats, options.controls));
    const results: ({ id: string; kind: 'fault' | 'control'; cell: keyof typeof CELLS; duration?: keyof typeof DURATIONS; repeat: number } &
      (ReturnType<typeof judgeHolds> | { verdict: 'INVALID'; floorReasons: string[]; reasons: string[]; setupAbort: boolean }) &
      { correctness?: ReturnType<typeof noticeCorrectness>['details'] })[] = [];
    const memory: AttemptMemory[] = [];
    let history = memoryWithInclusions(memory);
    let stopped: string | undefined;
    const rehearsal: { id: string; counts?: ReturnType<typeof rehearsalCounts>; error?: string }[] = [];
    for (const planned of queue.runs) {
      const id = runId(planned);
      const base = { id, kind: planned.kind, cell: planned.cell, duration: planned.kind === 'fault' ? planned.duration : undefined, repeat: planned.repeat };
      console.log(`#668 ${id}`);
      let run: Awaited<ReturnType<typeof measure>> | undefined;
      let error: unknown;
      try { run = await measure(context, planned); }
      catch (failure) { error = failure; await cleanup(active); }
      if (options.rehearsal) {
        rehearsal.push(run ? { id, counts: rehearsalCounts(run) } : { id, error: (error as Error).message });
        console.log(JSON.stringify(rehearsal.at(-1)));
        save('rehearsal.json', rehearsal);
        save('summary.json', { environment, rehearsal });
        continue;
      }
      if (run) {
        const judged = judgeHolds(run);
        const correctness = run.kind === 'fault' ? noticeCorrectness(run).details : undefined;
        results.push({ ...base, ...judged, correctness });
        memory.push({ ...memoryEntry(run, judged.verdict, judged.floors.hwmLowest), id, evidenceOnly: judged.evidenceOnly });
        history = memoryWithInclusions(memory, history);
        queue.record(planned, judged.verdict);
        console.log(JSON.stringify({ id, verdict: judged.verdict, floorReasons: judged.floorReasons, reasons: judged.reasons, evidence: judged.evidence.issues }));
      } else {
        const setupAbort = error instanceof SetupAbort;
        results.push({ ...base, verdict: 'INVALID', floorReasons: [`run did not complete: ${(error as Error).message}`], reasons: [], setupAbort });
        if (!queue.record(planned, setupAbort ? 'setup abort' : 'INVALID')) stopped = `two consecutive setup aborts for ${id}`;
      }
      save('results.json', results);
      const memoryVerdicts = Object.fromEntries(Object.entries(history).map(([key, group]) => [key, group.memory]));
      const memoryFailures = Object.fromEntries(Object.entries(history).map(([key, group]) => [key, group.failures]));
      save('summary.json', { environment, byCell: verdictByCell(results), memory: memoryVerdicts, memoryFailures, results, stopped });
      if (stopped) break;
    }
  }
} finally {
  await cleanup(active);
}
