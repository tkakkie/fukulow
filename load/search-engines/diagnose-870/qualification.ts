import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { cpuList, parseCpuSets } from '../../harness-core/cpusets.ts';
import { matches796, measuredSetsArg, sets796 } from '../../harness-core/frequency-layout.ts';
import { runsRequired } from '../../sql-probes/519-unread-counts/stability-chain.ts';

export const qualifiedCpuSets = `${measuredSetsArg};housekeeping=${cpuList(sets796.housekeeping)}`;

export function qualificationFor(cpuSets: string, logicalCpus: number, file: string) {
  const sets = parseCpuSets(cpuSets, logicalCpus);
  assert.ok(matches796(sets), `CPU sets must be the #796 sets ${qualifiedCpuSets}`);
  const q = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(q?.issue === 796 && q.result === 'PASS' && q.cpuSets === qualifiedCpuSets,
    'The #796 qualification is not recorded as PASS on the #796 CPU sets');
  const report = q.formalReport;
  assert.ok(typeof report?.path === 'string' && isAbsolute(report.path) &&
    typeof report.sha256 === 'string' && /^[a-f0-9]{64}$/.test(report.sha256),
  'The #796 qualification needs the formal report path and full SHA-256');
  const bytes = readFileSync(report.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), report.sha256, 'The #796 formal report hash differs');
  const verdict = JSON.parse(bytes.toString('utf8')) as {
    result?: string; reasons?: unknown[]; runs?: {name?: string; valid?: boolean}[];
  } | null;
  assert.ok(verdict?.result === 'PASS' && Array.isArray(verdict.reasons) && verdict.reasons.length === 0 &&
    Array.isArray(verdict.runs) && verdict.runs.length === runsRequired &&
    verdict.runs.every(run => run?.valid === true && typeof run.name === 'string' && run.name.trim()) &&
    new Set(verdict.runs.map(run => run.name)).size === runsRequired,
  'The #796 formal report must be PASS with three valid runs');
  return {sets, qualification: {file, issue: q.issue, result: q.result, cpuSets: q.cpuSets,
    formalReport: {path: report.path, sha256: report.sha256, runs: verdict.runs.map(run => run.name)}}};
}
