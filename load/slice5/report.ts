// Merges night 1 and night 2 into one #515 slice 5 report. Usage:
//   node load/slice5/report.ts --night1 /abs/dir --night2 /abs/dir > report.md
import { readdirSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { commits, partA, partB, partC, rounds, scope, thresholds, type Arm } from './config.ts';
import { confirmedPartDInfrastructure, judgePartA, judgePartB, judgePartC, judgePartD, vacuumCost, worst, type Metric, type RunA, type RunB, type RunC, type RunD, type Status, type Verdict } from './judge.ts';

type Night = { metadata: { night: string; smoke: boolean; parts: string[]; node: string; scope: string; commits: Record<string, string>; images: Record<string, string>; settingsHash: string; k6Id: string;
  machine: unknown; docker: unknown; harnessCommit: string; harnessHashes: Record<string, string>; dirty: string; started: string };
  summary: { failed: boolean; interrupted: string; faults: string[]; cleanupErrors: string[]; finished: string };
  results: (RunA | RunB | RunC | RunD)[]; partD?: ReturnType<typeof scorePartDFiles> };
const read = (dir: string, file: string) => JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readResults(dir: string): Night['results'] | null {
  try {
    const results = read(dir, 'results.json');
    if (Array.isArray(results) && results.every(isRecord)) return results as Night['results'];
  } catch { /* Part D can still be scored from its round files. */ }
  return null;
}

function validFailure(value: unknown): value is NonNullable<RunD['failure']> {
  return isRecord(value) && typeof value.cause === 'string'
    && ['assertion', 'infrastructure', 'timeout', 'unknown'].includes(value.cause)
    && (value.exitCode === null || Number.isInteger(value.exitCode))
    && (value.signal === null || typeof value.signal === 'string')
    && typeof value.timedOut === 'boolean' && (value.nightDeadline === undefined || typeof value.nightDeadline === 'boolean')
    && Array.isArray(value.evidence) && value.evidence.every(marker => typeof marker === 'string');
}

export function scorePartDFiles(dir: string, aggregate: Night['results'] | null,
  schedule: readonly (readonly Arm[])[] = rounds) {
  const runs: RunD[] = [], errors: string[] = [];
  const expected = schedule.flatMap((pair, index) => pair.map(arm => ({ id: `D-${index + 1}-${arm}`, arm, round: index + 1 })));
  const allowed = new Set(expected.flatMap(({ id }) => [id, `${id}-rerun`]));
  // Each night uses a shared runs directory, including the B and C artifacts.
  const otherCells = [...partA.cells.map(cell => `A-${cell.name}`), ...partB.cells.map(cell => `B-${cell}`), ...partC.cells.map(cell => `C-${cell}`)];
  const otherRuns = new Set(expected.flatMap(({ arm, round }) => otherCells.map(cell => `${cell}-${round}-${arm}`)));
  let names: string[] = [];
  try {
    names = readdirSync(`${dir}/runs`, { withFileTypes: true })
      .filter(entry => entry.name.startsWith('D-') || (entry.isDirectory() && !otherRuns.has(entry.name)))
      .map(entry => entry.name).sort();
  }
  catch { errors.push('Part D runs directory unavailable'); }
  const readRound = (id: string, slot?: { arm: Arm; round: number }): RunD | undefined => {
    const path = `runs/${id}/result.json`;
    let value: unknown;
    try { value = read(dir, path); }
    catch {
      if (slot) errors.push(`${path}: missing, unreadable or corrupt`);
      return;
    }
    if (!slot && isRecord(value) && value.arm === 'A' &&
      typeof value.round === 'number' && Number.isInteger(value.round) && value.round > 0) {
      slot = { arm: 'A', round: value.round };
    }
    if (!slot) return;
    if (!isRecord(value) || value.part !== 'D' || value.arm !== slot.arm || value.round !== slot.round) {
      errors.push(`${path}: inconsistent Part D round identity`);
      return;
    }
    const failure = validFailure(value.failure) ? value.failure : null;
    const pg = value.postgres;
    if (typeof value.commit !== 'string' || !value.commit.startsWith(commits[slot.arm])
      || typeof value.smoke !== 'boolean' || !(Number.isFinite(value.topics) || value.topics === null)
      || !Array.isArray(value.rows) || !value.rows.every(row => isRecord(row) &&
        typeof row.key === 'string' && Number.isFinite(row.p95) && Number.isInteger(row.n))
      || value.complete !== (value.rows.length === 4)
      || !(Number.isInteger(value.exitCode) || (value.exitCode === null && failure))
      || (failure ? failure.exitCode !== value.exitCode : value.failure !== null)
      || !(pg === null || (isRecord(pg) && typeof pg.Running === 'boolean' && typeof pg.OOMKilled === 'boolean'
        && Number.isInteger(pg.ExitCode) && (pg.Health === null || typeof pg.Health === 'string')))
      || !Array.isArray(value.postgresLogMarkers) || !value.postgresLogMarkers.every(marker => typeof marker === 'string')) {
      errors.push(`${path}: corrupt Part D round data`);
      if (slot.arm !== 'A' || failure?.cause !== 'assertion') return;
    }
    return value as RunD;
  };

  let reruns = 0;
  for (const slot of expected) {
    const { id, arm } = slot;
    const initial = readRound(id, slot);
    if (!names.includes(`${id}-rerun`)) {
      if (initial) runs.push(initial);
      continue;
    }
    reruns++;
    const rerun = readRound(`${id}-rerun`, slot);
    if (!initial || !confirmedPartDInfrastructure(initial)) {
      errors.push(`${id}-rerun: rerun without confirmed infrastructure`);
      if (rerun?.failure?.cause === 'assertion' && arm === 'A') runs.push(rerun);
      if (initial) runs.push(initial);
    } else {
      runs.push(rerun ?? initial);
    }
  }
  if (reruns > 1) errors.push('multiple Part D reruns');
  for (const name of names) {
    if (allowed.has(name)) continue;
    errors.push(`unexpected Part D run directory ${name}`);
    const duplicate = readRound(name);
    if (duplicate?.failure?.cause === 'assertion') runs.push(duplicate);
  }
  const aggregateRuns = aggregate?.filter(r => r.part === 'D');
  const discrepancy = !aggregateRuns ? 'results.json unavailable for Part D comparison'
    : aggregateRuns.length !== runs.length || runs.some(run =>
      !isDeepStrictEqual(aggregateRuns.filter(r => r.round === run.round && r.arm === run.arm), [run]))
      ? 'results.json disagrees with Part D round files' : undefined;
  return {
    failed: errors.length > 0 || runs.some(run => !!run.failure),
    verdicts: judgePartD(runs, errors).map(v => discrepancy ? { ...v, reasons: [...v.reasons, discrepancy] } : v),
  };
}

export function load(dir: string): Night {
  const metadata: Night['metadata'] = read(dir, 'metadata.json');
  const summary: Night['summary'] = read(dir, 'summary.json');
  if (!metadata.parts.includes('D')) return { metadata, summary, results: read(dir, 'results.json') };
  const results = readResults(dir);
  return { metadata, summary, results: results ?? [], partD: scorePartDFiles(dir, results, metadata.smoke ? [rounds[0]] : rounds) };
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
    ...partC.cells.map(c => judgePartC(runs<RunC>('C'), c)), ...(n2.partD?.verdicts ?? judgePartD([]))];
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
