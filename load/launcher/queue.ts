import { isAbsolute } from 'node:path';
import type { HostRequirements } from '../harness-core/host-record.ts';

// A queue file: the approved jobs of one chain, in order (#867). The launcher runs each job once.
export type Job = {
  name: string;
  issue: number;
  // The maintainer's go, quoted from chat, with its date. A job without one is refused.
  go: { quote: string; date: string };
  worktree: string;
  commit: string;
  command: string[];
  out: string;
  // Optional job gate run before launch, for example the d3r capacity check. Non-zero exit is a STOP.
  gate?: string[];
  // Containers whose logs are captured into the chain directory while the job runs (`docker ps --filter label=...`).
  postgresLogLabel?: string;
  // Image for the Docker disk headroom probe, and the free space both the host and Docker need.
  image?: string;
  minFreeGiB?: number;
  env?: Record<string, string>;
  // Docker label of the containers the job starts (`docker ps --filter label=...`). Before HOST-BUSY
  // is released, any still running are removed and their absence is confirmed.
  workloadLabel?: string;
  // Maintainer confirmations of conditions the host cannot read (for example #796 L3 airflow),
  // quoted from chat with their date, copied into the chain's session.json.
  confirmations?: Record<string, { quote: string; date: string }>;
  // #796 cooling plan: host settings that must hold before the job (unreadable is a STOP), a
  // cool-down wait before it (Tctl at most maxTctlC within maxWaitSeconds, else STOP) and a
  // thermal sample every thermalSampleSeconds while it runs.
  requireHost?: HostRequirements;
  cooldown?: { maxTctlC: number; maxWaitSeconds: number };
  thermalSampleSeconds?: number;
};
export type Queue = { name: string; chainDir: string; hostBusy: string; jobs: Job[] };

const isString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isArgv = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(isString);

function jobProblems(j: Record<string, unknown>, i: number): string[] {
  const at = `job ${i + 1}${isString(j.name) ? ` (${j.name})` : ''}`;
  const p: string[] = [];
  const go = j.go as Record<string, unknown> | undefined;
  if (!isString(j.name) || !/^[\w.-]+$/.test(j.name)) p.push(`${at}: name must be [A-Za-z0-9_.-]+`);
  if (!Number.isSafeInteger(j.issue) || (j.issue as number) < 1) p.push(`${at}: issue must be an Issue number`);
  if (!go || !isString(go.quote) || !isString(go.date)) p.push(`${at}: no quoted go from the maintainer (go.quote and go.date)`);
  if (!isString(j.worktree) || !isAbsolute(j.worktree)) p.push(`${at}: worktree must be an absolute path`);
  if (!isString(j.commit) || !/^[0-9a-f]{7,40}$/.test(j.commit)) p.push(`${at}: commit must be a hex SHA (7-40)`);
  if (!isArgv(j.command)) p.push(`${at}: command must be a non-empty argv`);
  if (!isString(j.out) || !isAbsolute(j.out)) p.push(`${at}: out must be an absolute path`);
  if (j.gate !== undefined && !isArgv(j.gate)) p.push(`${at}: gate must be a non-empty argv`);
  if (j.minFreeGiB !== undefined && !(typeof j.minFreeGiB === 'number' && j.minFreeGiB >= 0)) p.push(`${at}: minFreeGiB must be a number >= 0`);
  if (j.workloadLabel !== undefined && !(isString(j.workloadLabel) && /^[\w.\-/]+(=[\w.\-/]+)?$/.test(j.workloadLabel))) p.push(`${at}: workloadLabel must be key or key=value`);
  // A job that uses Docker (it names its image) must name the label of its containers, so a stop can
  // find and remove them; the release also fails closed on any container left (launcher.ts).
  if (j.image !== undefined && j.workloadLabel === undefined) p.push(`${at}: a job with an image needs its workloadLabel`);
  const conf = j.confirmations as Record<string, unknown> | undefined;
  if (conf !== undefined && (typeof conf !== 'object' || conf === null || Object.keys(conf).length === 0
    || !Object.values(conf).every(c => isString((c as Record<string, unknown>)?.quote) && isString((c as Record<string, unknown>)?.date)))) {
    p.push(`${at}: confirmations must map each condition to a quote and a date`);
  }
  p.push(...coolingProblems(j, at));
  return p;
}

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
function coolingProblems(j: Record<string, unknown>, at: string): string[] {
  const p: string[] = [];
  const req = j.requireHost as Record<string, unknown> | undefined;
  if (req !== undefined) {
    const known = ['boost', 'policyBoost', 'platformProfile', 'fanControl'];
    if (typeof req !== 'object' || req === null || Object.keys(req).length === 0) p.push(`${at}: requireHost must be a non-empty object`);
    else {
      for (const k of Object.keys(req)) if (!known.includes(k)) p.push(`${at}: requireHost.${k} is not a known setting`);
      for (const k of ['boost', 'policyBoost', 'platformProfile']) if (req[k] !== undefined && !isString(req[k])) p.push(`${at}: requireHost.${k} must be a string`);
      const fan = req.fanControl as Record<string, unknown> | undefined;
      if (fan !== undefined && (typeof fan !== 'object' || fan === null || Object.keys(fan).length === 0 || !Object.values(fan).every(v => Number.isInteger(v)))) {
        p.push(`${at}: requireHost.fanControl must map hwmon readings to integers`);
      }
    }
  }
  const c = j.cooldown as Record<string, unknown> | undefined;
  if (c !== undefined && (typeof c !== 'object' || c === null || !positive(c.maxTctlC) || !positive(c.maxWaitSeconds))) p.push(`${at}: cooldown needs maxTctlC and maxWaitSeconds > 0`);
  if (j.thermalSampleSeconds !== undefined && !positive(j.thermalSampleSeconds)) p.push(`${at}: thermalSampleSeconds must be > 0`);
  return p;
}

// Returns the queue, or throws with every problem found, so a bad queue is fixed in one pass.
export function parseQueue(text: string): Queue {
  const q = JSON.parse(text) as Record<string, unknown>;
  const p: string[] = [];
  if (!isString(q.name)) p.push('queue name is required');
  if (!isString(q.chainDir) || !isAbsolute(q.chainDir)) p.push('chainDir must be an absolute path');
  if (!isString(q.hostBusy) || !isAbsolute(q.hostBusy)) p.push('hostBusy must be an absolute path');
  if (!Array.isArray(q.jobs) || q.jobs.length === 0) p.push('jobs must be a non-empty list');
  else {
    q.jobs.forEach((j, i) => p.push(...jobProblems(j as Record<string, unknown>, i)));
    const names = (q.jobs as Job[]).map(j => j.name);
    const outs = (q.jobs as Job[]).map(j => j.out);
    if (new Set(names).size !== names.length) p.push('job names must be unique');
    if (new Set(outs).size !== outs.length) p.push('job outputs must be unique');
  }
  if (p.length > 0) throw new Error(`invalid queue:\n- ${p.join('\n- ')}`);
  return q as unknown as Queue;
}
