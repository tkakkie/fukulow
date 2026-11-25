import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parseQueue } from '../../launcher/queue.ts';
import { parseSamples } from '../../harness-core/thermal.ts';
import { judgeRun, replayLegacyRun, type RunInput } from './stability-judge.ts';
import { judgeChain, sessionProblems } from './stability-chain.ts';
import { controlFloors, frozenFloors } from './frequency-approval.ts';
import { clientCpuEquivalents } from './frequency-report.ts';
import { controlSpotCheck } from './frequency-turbostat.ts';
import { legacyDisagreements } from './frequency-legacy-report.ts';

const usage = 'node load/sql-probes/519-unread-counts/stability.ts --stage control|rehearsal2|formal --queue QUEUE_FILE --out NEW_REPORT [--control-review FILE]';
const { values } = parseArgs({ options: { stage: { type: 'string' }, queue: { type: 'string' }, out: { type: 'string' },
  'control-review': { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) { console.log(usage); process.exit(0); }
const stage = values.stage;
if (!values.queue || !values.out || (stage !== 'control' && stage !== 'rehearsal2' && stage !== 'formal')) throw new Error(usage);
if (existsSync(values.out)) throw new Error(`refusing to overwrite ${values.out}`);
const approval = stage === 'formal' ? frozenFloors() : stage === 'rehearsal2' ? controlFloors(values['control-review']) : null;
const q = parseQueue(readFileSync(values.queue, 'utf8'));
const text = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
const json = (path: string) => { const t = text(path); return t === null ? null : JSON.parse(t); };

const runs: RunInput[] = q.jobs.map(job => {
  const metadata = json(join(job.out, 'metadata.json'));
  if (metadata && metadata.frequencyStage !== stage) throw new Error('STOP: report is only for newly collected #796 v3 evidence of the selected stage');
  const frequencyStart = json(join(job.out, 'frequency-start.json'));
  const frequencyEnd = json(join(job.out, 'frequency-end.json'));
  const status = json(join(job.out, 'status.json'));
  return {
    name: job.name, out: job.out, complete: status?.complete === true, statusSession: status?.launchSession,
    sends: json(join(job.out, 'sends.json'))?.sends ?? [],
    metadata: metadata ?? { cpuSets: null, sends: { measuredSeconds: NaN } },
    hostBefore: json(join(q.chainDir, `${job.name}-host-before.json`)),
    hostAfter: json(join(q.chainDir, `${job.name}-host-after.json`)),
    cooldown: json(join(q.chainDir, `${job.name}-cooldown.json`)),
    launchCheck: json(join(q.chainDir, `${job.name}-launch-check.json`)),
    clockEvents: json(join(q.chainDir, `${job.name}-clock-events.json`)),
    samples: parseSamples(text(join(q.chainDir, `${job.name}-thermal.jsonl`)) ?? ''),
    frequency: frequencyStart && frequencyEnd ? { ...frequencyStart, ...frequencyEnd } : null,
    hostAffinity: json(join(job.out, 'frequency-host-affinity.json')),
  };
});
const session = json(join(q.chainDir, 'session.json'));
if (stage === 'formal') {
  const verdict = judgeChain(runs, session, q.name, (run, binding) => judgeRun(run, binding, approval!.floors, stage, approval!.sha256));
  writeFileSync(values.out, JSON.stringify(verdict, null, 2) + '\n', { flag: 'wx' });
  console.log(verdict.result, ...verdict.reasons);
  process.exit(verdict.result === 'PASS' ? 0 : 3);
}

if (runs.length !== 1 || q.jobs[0].issue !== 796) throw new Error('diagnostic report requires one #796 launcher job');
const [run] = runs;
const binding = { id: session?.id ?? null, thermalSampleSeconds: session?.jobs?.[0]?.thermalSampleSeconds, go: session?.jobs?.[0]?.frequencyGo };
const judged = judgeRun(run, binding, approval?.floors ?? null, stage, approval?.sha256);
const spot = stage === 'control' ? controlSpotCheck(json(join(run.out, 'frequency-turbostat.json')), judged.frequency) : null;
const legacy = stage === 'rehearsal2' ? replayLegacyRun(run, binding) : null;
const baselineCooldown = stage === 'control' ? json(join(run.out, 'frequency-baseline-cooldown.json')) : null;
const last = baselineCooldown?.readings?.at(-1);
const coolProblems = stage === 'control' && !(baselineCooldown?.ok === true && last?.elapsedMs >= 0 &&
  last.elapsedMs <= 1_200_000 && typeof last.tctlC === 'number' && last.tctlC <= 50) ? ['control baseline did not start cool'] : [];
const reasons = [...coolProblems, ...sessionProblems(session, q.name, runs), ...judged.invalid, ...(spot?.problems ?? [])];
const report = {
  stage, valid: reasons.length === 0, reasons, approval, session, go: binding.go,
  evidence: { calibration: run.frequency, hostAffinity: run.hostAffinity, sends: run.sends, metadata: run.metadata, hostBefore: run.hostBefore,
    hostAfter: run.hostAfter, baselineCooldown, cooldown: run.cooldown, launchCheck: run.launchCheck, clockEvents: run.clockEvents },
  frequency: judged.frequency, blocks: judged.blocks, clientCpuEquivalents: clientCpuEquivalents(judged.frequency),
  turbostat: spot, legacy: legacy && { valid: legacy.valid, invalid: legacy.invalid, disagreements: legacyDisagreements(legacy.legacy, judged.frequency, run.sends.map(s => s.order)) },
};
writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(report.valid ? 'DIAGNOSTIC VALID' : 'DIAGNOSTIC INVALID', ...reasons);
process.exit(report.valid ? 0 : 3);
