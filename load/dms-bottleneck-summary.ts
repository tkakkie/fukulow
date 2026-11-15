// Summarize measurement-only lifetime samples; no request/SQL duration subtraction.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { percentile } from './dms-workload.ts';
const directory = resolve(process.argv[2]);
const from = Number(process.env.DM_WINDOW_FROM || 0), to = Number(process.env.DM_WINDOW_TO || Number.MAX_SAFE_INTEGER);
const groups = new Map<string, { wait: number[]; hold: number[]; returning: number[]; owner: number[]; active: number[]; waiting: number[]; http: number[]; unacquired: number }>();
for (const line of readFileSync(`${directory}/app.log`, 'utf8').split('\n')) {
  const m = /event=measure_hold op=(\S+) wait_us=(\d+) hold_us=(\d+) active=(\d+) waiting=(\d+) http=(\d+) acquired=(true|false) at_ms=(\d+)/.exec(line);
  if (!m || Number(m[8]) < from || Number(m[8]) >= to) continue;
  const key = m[1];
  if (!groups.has(key)) groups.set(key, { wait: [], hold: [], returning: [], owner: [], active: [], waiting: [], http: [], unacquired: 0 });
  const g = groups.get(key)!;
  if (m[7] === 'false') { g.unacquired++; continue; }
  const returning = Number(/return_us=(\d+)/.exec(line)?.[1] || 0)/1000;
  g.returning.push(returning); g.owner.push(Number(m[3])/1000-returning);
  g.wait.push(Number(m[2])/1000); g.hold.push(Number(m[3])/1000); g.active.push(Number(m[4])); g.waiting.push(Number(m[5])); g.http.push(Number(m[6]));
}
const distribution = (v: number[]) => ({ n: v.length, mean: v.reduce((a,b)=>a+b,0)/v.length, p95: percentile(v,.95), p99: percentile(v,.99), max: percentile(v,1) });
const report = Object.fromEntries([...groups].map(([k,g]) => [k, { wait: distribution(g.wait), hold: distribution(g.hold), owner: distribution(g.owner), returning: distribution(g.returning), active: distribution(g.active), waiting: distribution(g.waiting), http: distribution(g.http), unacquired: g.unacquired }]));
writeFileSync(`${directory}/hold-summary.json`, JSON.stringify({ window: {from,to}, operations: report }, null, 2));
console.log(JSON.stringify(report, null, 2));
