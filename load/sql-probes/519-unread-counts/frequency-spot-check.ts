import { spawn } from 'node:child_process';
import { hrtime } from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { unsigned } from './frequency-ratios.ts';

const ready = 'FUKULOW_TURBOSTAT_READY';
// The exact argv the scoped sudoers entry allows. sudo-rs matches sudoers arguments word by word, so no
// element may contain whitespace (a `/bin/sh -c` script never matches).
export const turbostatArgv = ['/usr/bin/turbostat', '--quiet', '--show', 'CPU,TSC_MHz',
  '--add', 'msr0xe8,u64,cpu,delta,APERF', '--add', 'msr0xe7,u64,cpu,delta,MPERF', '--', '/usr/bin/cat'];
// Command mode takes its opening sample before spawning cat, the stdin barrier. The ready line written to
// stdin comes back on stdout only once cat runs; ending stdin ends cat and takes the closing sample.
export async function withSpotCheck<T>(work: () => Promise<T>, signal: AbortSignal, keep: (raw: SpotCheck) => void) {
  const child = spawn('sudo', ['-n', ...turbostatArgv], { signal });
  let stdout = '', stderr = '';
  let startNs: string | null = null, stopNs: string | null = null;
  child.stdin.on('error', () => {});
  const opened = new Promise<void>(resolve => {
    child.stdout.setEncoding('utf8').on('data', data => {
      stdout += data;
      if (startNs === null && stdout.includes(ready)) {
        startNs = String(hrtime.bigint());
        resolve();
      }
    });
  });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  child.stdin.write(`${ready}\n`);
  const exit = new Promise<number | null>(resolve => {
    child.once('error', () => resolve(null));
    child.once('close', resolve);
  });
  const bounded = async <R>(step: Promise<R>, phase: string) => {
    const timer = new AbortController();
    try {
      return await Promise.race([step, wait(5000, undefined, { signal: timer.signal })
        .then(() => { throw new Error(`turbostat ${phase} sample timed out`); })]);
    } finally { timer.abort(); }
  };
  try {
    await bounded(Promise.race([opened, exit.then(() => { throw new Error('turbostat exited before its opening sample'); })]), 'opening');
    const result = await work();
    stopNs = String(hrtime.bigint());
    child.stdin.end('stop\n');
    if (await bounded(exit, 'closing') !== 0) throw new Error('turbostat failed');
    return result;
  } finally {
    child.stdin.destroy();
    child.kill();
    keep({ startNs, stopNs, stdout, stderr });
  }
}

export type SpotCheck = { startNs: string | null; stopNs: string | null; stdout: string; stderr: string };
export function spotReadings(raw: SpotCheck) {
  const rows = `${raw.stdout}\n${raw.stderr}`.trim().split('\n').map(l => l.trim().split(/\s+/));
  const fields = ['CPU', 'TSC_MHz', 'APERF', 'MPERF'];
  const header = rows.find(r => fields.every(field => r.includes(field)));
  if (!header) throw new Error('turbostat frequency columns missing');
  const [ci, ti, ai, mi] = fields.map(k => header.indexOf(k));
  return rows.slice(rows.indexOf(header) + 1).flatMap(r => {
    if (!/^\d+$/.test(r[ci] ?? '')) return [];
    const cpu = Number(r[ci]), tscMhz = Number(r[ti]);
    const aperf = unsigned(r[ai]), mperf = unsigned(r[mi]);
    if (!(Number.isFinite(tscMhz) && tscMhz > 0) || (aperf === 0n) !== (mperf === 0n)) throw new Error(`unreadable turbostat CPU ${cpu}`);
    return [{ cpu, tscMhz, aperf: r[ai], mperf: r[mi], ratio: mperf === 0n ? null : Number(aperf) / Number(mperf) }];
  }).sort((a, b) => a.cpu - b.cpu);
}
