// #668: revocation holds at high counts (several WebSockets per Member), path A inducement.
// Runs only on the maintainer's go, in the measurement session; never in CI.
// Run: ulimit -n 65536; node load/revocation-holds.ts --out /absolute/new/dir [--cells H512,...] [--durations short,long] [--repeats 3] [--controls on|off]
//   [--stall-senders 8] [--stall-messages 10] [--stall-chars 4000]
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { outsideCheckout } from './proxy-target.ts';
import { THRESHOLDS } from './revocation-burst-judgment.ts';
import { judgeHolds, verdictByCell, type HoldsVerdict } from './revocation-holds-judgment.ts';
import { memoryByCell, memoryEntry, type MemoryEntry } from './revocation-holds-memory.ts';
import { noticeCorrectness } from './revocation-holds-notices.ts';
import { CELLS, DURATIONS, parseOptions, planRuns, runId, TIMELINE } from './revocation-holds-plan.ts';
import { cleanup, measure, type Active } from './revocation-holds-run.ts';

const checkout = resolve(import.meta.dirname, '..');
const binary = resolve(checkout, 'target/release/fukulow-server');
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('node load/revocation-holds.ts --out /absolute/new/dir [--cells ...] [--durations short,long] [--repeats n] [--controls on|off]'); process.exit(0); }
const options = parseOptions(args);
const output = outsideCheckout(options.out);
if (existsSync(output)) throw new Error('Output directory already exists');
if (process.version !== 'v26.13.1') throw new Error('Use Node 26.13.1');
if (!existsSync(binary)) throw new Error('Build the release server first: cargo build --release --locked -p fukulow-server');
mkdirSync(output, { recursive: true });

const active: Active = {};
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { interrupted = true; void cleanup(active).then(() => process.exit(130)); });

const environment = {
  node: process.version, platform: platform(), arch: arch(), release: release(), cpus: cpus().length, memoryBytes: totalmem(),
  cells: CELLS, durations: DURATIONS, timeline: TIMELINE, stall: options.stall, thresholds: THRESHOLDS,
  commit: (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim(),
};
writeFileSync(resolve(output, 'environment.json'), JSON.stringify(environment, null, 2));
type Result = { id: string; kind: 'fault' | 'control'; cell: keyof typeof CELLS; duration?: keyof typeof DURATIONS; repeat: number; verdict: HoldsVerdict; floorReasons: string[]; reasons: string[]; floors?: unknown; correctness?: unknown; informational?: unknown };
const results: Result[] = [], memory: MemoryEntry[] = [];
const write = () => writeFileSync(resolve(output, 'results.json'), JSON.stringify(results, null, 2));
try {
  for (const planned of planRuns(options.cells, options.durations, options.repeats, options.controls)) {
    if (interrupted) break;
    const id = runId(planned);
    const base = { id, kind: planned.kind, cell: planned.cell, duration: planned.kind === 'fault' ? planned.duration : undefined, repeat: planned.repeat };
    console.log(`#668 ${id}`);
    try {
      const run = await measure({ binary, output, stall: options.stall, active, interrupted: () => interrupted }, planned);
      const judged = judgeHolds(run);
      const correctness = run.kind === 'fault' ? noticeCorrectness(run).details : undefined;
      results.push({ ...base, ...judged, correctness });
      memory.push(memoryEntry(run, judged.verdict, judged.floors.hwm));
    } catch (error) {
      // A run that could not complete its setup is below floor 1.
      results.push({ ...base, verdict: 'INVALID', floorReasons: [`run did not complete: ${(error as Error).message}`], reasons: [] });
      await cleanup(active);
    }
    const last = results.at(-1)!;
    console.log(JSON.stringify({ id, verdict: last.verdict, floorReasons: last.floorReasons, reasons: last.reasons }));
    write();
  }
} finally {
  await cleanup(active);
}
const byCell = verdictByCell(results);
const memoryVerdicts = memoryByCell(memory);
writeFileSync(resolve(output, 'summary.json'), JSON.stringify({ environment, byCell, memory: memoryVerdicts, results }, null, 2));
console.log(JSON.stringify({ byCell, memory: memoryVerdicts }));
