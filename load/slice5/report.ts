// Merges night 1 and night 2 into one #515 slice 5 report. Usage:
//   node load/slice5/report.ts --night1 /abs/dir --night2 /abs/dir > report.md
import { readFileSync } from 'node:fs';
import { partA, partB, partC, scope, thresholds } from './config.ts';
import { judgePartA, judgePartB, judgePartC, judgePartD, vacuumCost, worst, type Metric, type RunA, type RunB, type RunC, type RunD, type Status, type Verdict } from './judge.ts';

type Night = { metadata: { night: string; smoke: boolean; parts: string[]; node: string; scope: string; commits: Record<string, string>; images: Record<string, string>; settingsHash: string; k6Id: string;
  machine: unknown; docker: unknown; harnessCommit: string; harnessHashes: Record<string, string>; dirty: string; started: string };
  summary: { failed: boolean; interrupted: string; faults: string[]; cleanupErrors: string[]; finished: string };
  results: (RunA | RunB | RunC | RunD)[] };
export function load(dir: string): Night {
  const read = (f: string) => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  return { metadata: read('metadata.json'), summary: read('summary.json'), results: read('results.json') };
}

// Both nights must share commits, images, settings and the k6 image, and finish cleanly; otherwise nothing passes.
export function mergeProblems(n1: Night, n2: Night): string[] {
  const p: string[] = [];
  if (n1.metadata.night !== '1' || n2.metadata.night !== '2') p.push('night order');
  if (JSON.stringify(n1.metadata.parts) !== JSON.stringify(['A']) || JSON.stringify(n2.metadata.parts) !== JSON.stringify(['B', 'C', 'D'])) p.push('missing or unexpected parts');
  if ([n1, n2].some(n => n.metadata.node !== 'v26.13.1')) p.push('Node version mismatch');
  if ([n1, n2].some(n => n.metadata.scope !== scope)) p.push('scope mismatch');
  if ([n1, n2].some(n => n.metadata.smoke)) p.push('smoke output');
  for (const k of ['commits', 'images', 'settingsHash', 'k6Id', 'harnessCommit', 'harnessHashes'] as const)
    if (JSON.stringify(n1.metadata[k]) !== JSON.stringify(n2.metadata[k])) p.push(`${k} differ between nights`);
  for (const n of [n1, n2]) {
    if (n.summary.failed || n.summary.interrupted) p.push(`night ${n.metadata.night}: ${n.summary.interrupted || 'runner failed'}`);
    if (n.summary.cleanupErrors.length) p.push(`night ${n.metadata.night}: cleanup errors`);
    if (n.metadata.dirty) p.push(`night ${n.metadata.night}: dirty harness checkout`);
  }
  return p;
}

export function verdicts(n1: Night, n2: Night): { problems: string[]; verdicts: Verdict[]; overall: Status } {
  const problems = mergeProblems(n1, n2), all = [...n1.results, ...n2.results];
  const runs = <T>(p: string) => all.filter(r => r.part === p) as T[];
  let list = [...partA.cells.map(c => judgePartA(runs<RunA>('A'), c.name)), ...partB.cells.map(c => judgePartB(runs<RunB>('B'), c)),
    ...partC.cells.map(c => judgePartC(runs<RunC>('C'), c)), ...judgePartD(runs<RunD>('D'))];
  // A run-level problem turns every PASS into INVALID; FAIL and INVESTIGATE stay visible.
  if (problems.length) list = list.map(v => v.status === 'PASS' ? { ...v, status: 'INVALID' as Status, reasons: [...v.reasons, ...problems] } : v);
  return { problems, verdicts: list, overall: worst(list.map(v => v.status).filter(s => s !== 'REPORT ONLY')) };
}

const num = (n: number | undefined, d = 3) => n === undefined || !Number.isFinite(n) ? 'n/a' : Number(n.toFixed(d)).toString();
const metricLine = (m: Metric) => `${m.name}: **${m.status}** — B ${num(m.medianB)}, A ${num(m.medianA)}, A/B ${num(m.ratio)}` +
  `, pairs [${(m.pairRatios ?? []).map(r => num(r)).join(', ')}], spread B ${num(m.spreadB)} / A ${num(m.spreadA)}${m.reason ? ` (${m.reason})` : ''}`;

export function render(n1: Night, n2: Night): string {
  const { problems, verdicts: list, overall } = verdicts(n1, n2);
  const runsA = n1.results.filter(r => r.part === 'A') as RunA[];
  const sum = (arm: string, f: (r: RunA) => number) => runsA.filter(r => r.arm === arm).reduce((s, r) => s + f(r), 0);
  const steps = (r: RunA, k: 'vacuumAfter' | 'checkpointAfter', f: 'walBytes' | 'ms') => r.steps.reduce((s, x) => s + x[k][f], 0);
  const lines = [
    `## #515 slice 5 measurement report`, '', `Scope: ${scope}.`,
    `- The DB settings (\`max_wal_size=8GB\`, \`checkpoint_timeout=30min\`, insert-triggered autovacuum off) are control conditions for this comparison. **This is not a pass at production defaults.**`,
    '- Formal absolute performance stays with #431. Catch-up values from before slice 3 are not compared with these.', '',
    `**Overall: ${overall}** (only PASS passes; INVALID, NOT EVALUATED and INVESTIGATE never do).`,
    ...(problems.length ? ['', `Run-level problems: ${problems.join('; ')}`] : []), '',
    '| Part | Cell | Status | Reasons |', '|---|---|---|---|',
    ...list.map(v => `| ${v.part} | ${v.cell} | ${v.status} | ${v.reasons.join('; ') || '-'} |`), '',
    '### Metrics', ...list.flatMap(v => v.metrics.map(m => `- ${v.part} ${v.cell}: ${metricLine(m)}`)), '',
    '### Hidden operational cost of the control settings (Q2)',
    'Work the settings moved out of the measured windows, done explicitly before every step and after the last one:',
    '| Arm | Explicit VACUUM WAL (bytes) | VACUUM time (ms) | Explicit CHECKPOINTs | CHECKPOINT WAL (bytes) | CHECKPOINT time (ms) | CHECKPOINT buffers written | Checkpoints inside steps |', '|---|---|---|---|---|---|---|---|',
    ...['B', 'A'].map(arm => `| ${arm} | ${num(sum(arm, r => steps(r, 'vacuumAfter', 'walBytes')), 0)} | ${num(sum(arm, r => steps(r, 'vacuumAfter', 'ms')), 0)} | ${num(sum(arm, r => r.steps.length), 0)} | ${num(sum(arm, r => steps(r, 'checkpointAfter', 'walBytes')), 0)} | ${num(sum(arm, r => steps(r, 'checkpointAfter', 'ms')), 0)} | ${num(sum(arm, r => r.steps.reduce((s, x) => s + x.checkpointAfter.buffersWritten, 0)), 0)} | ${num(sum(arm, r => r.steps.reduce((s, x) => s + x.wal.checkpointsInside, 0)), 0)} |`), '',
    `### Explicit VACUUM comparison (Q3, report-only; above ${thresholds.vacuumDecisionRatio}x needs a maintainer decision)`,
    ...partA.cells.map(c => { const v = vacuumCost(runsA, c.name); return `- ${c.name}: **${v.status}**${'metrics' in v && v.metrics ? ' — ' + v.metrics.map(m => `${m.name} A/B ${num(m.ratio)}`).join(', ') : ''}`; }), '',
    '### R2 WebSocket replay (report-only)',
    ...n2.results.filter((r): r is RunC => r.part === 'C').map(r => `- ${r.cell} ${r.arm}${r.round}: ${r.r2?.status ?? 'NOT EVALUATED'}; invalid ${num(r.r2?.invalid)}, errors ${num(r.r2?.errors)}, p95 ${num(r.r2?.p95 ?? undefined)} ms`), '',
    '### Required conditions outside the timed gates',
    '- Q4: WebSocket correctness and reconnect convergence are required test gates; their CI status must be verified at A (`f7fe08a`): `replay_pages_handoff_and_reconnect_keep_independent_channel_sequences_without_gaps`, `overflow_closes_socket_and_reconnect_replays_every_committed_message`, `replay_denies_other_organization_and_private_nonmember_with_positive_controls`, `create_envelope_keeps_log_position_when_replay_hydrates_a_newer_version` (server/src/realtime/tests.rs), plus the client sync contract scenarios (contract/realtime, web protocol tests). WebSocket replay (R2) timing is report-only, in each Part C result file.',
    '- Q6: Unread performance goes to #519 and #431; nonzero-density Mention performance goes to #431. #515 functional, RLS and contract tests are not skipped.',
    '- Q7: WebSocket delivery (Part E) was not run; it is report-only and handed to #431.',
    `- Q8: Part B cells where only A saturated the host (≥${partB.hostSaturationPercent}% VM CPU) are INVESTIGATE: ${list.filter(v => v.status === 'INVESTIGATE').map(v => v.cell).join(', ') || 'none'}.`,
    `- Part C judged path: R1 gap fill, ${partC.readers} readers × ${partC.requests} pages of ${partC.limit} consecutive positions.`, '',
    '### Runs', ...[n1, n2].map(n => `- Night ${n.metadata.night}: ${n.metadata.started} → ${n.summary.finished}; harness ${n.metadata.harnessCommit}; faults: ${n.summary.faults.join('; ') || 'none'}`),
    '', 'For every FAIL, the result comment gives the cause, impact and improvement options. There is no open-ended re-measurement.',
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const flag = (n: string) => { const i = process.argv.indexOf(n); if (i < 0 || !process.argv[i + 1]) throw new Error('Use --night1 DIR --night2 DIR'); return process.argv[i + 1]; };
  console.log(render(load(flag('--night1')), load(flag('--night2'))));
}
