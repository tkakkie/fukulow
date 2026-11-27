// Only this taskset-pinned host process reads /proc/diskstats during pgbench.
import { readFileSync } from 'node:fs';
import { allowedCpus } from '../../harness-core/cpusets.ts';
import { diskDelta, parseDiskstats, type DiskRow } from './diskstats.ts';

type Sample = { phase: 'start' | 'interval' | 'end'; atMs: number; monoMs: number; counters: DiskRow[] };
export type DiskSeries = { samples: Sample[]; deltas: DiskRow[]; errors: string[] };
export type SamplerPlacement = { pid: number; cpus: number[]; cgroup: string };
export type SamplerMessage = { placement: SamplerPlacement } | { label: string; series: DiskSeries };
export type SamplerCommand = { phase: 'start' | 'end'; label: string };

const ids = process.argv.slice(2);
const send = (message: SamplerMessage) => process.send!(message);
const read = (path: string) => readFileSync(path, 'utf8');
let label: string;
let series: DiskSeries;
let timer: ReturnType<typeof setInterval>;
function sample(phase: Sample['phase']) {
  const atMs = Date.now(), monoMs = Number(process.hrtime.bigint()) / 1e6;
  try { series.samples.push({ phase, atMs, monoMs, counters: parseDiskstats(read('/proc/diskstats'), ids) }); }
  catch (error) { series.errors.push(`${phase} sample at ${atMs}: ${String(error)}`); }
}

process.on('message', ({ phase, label: block }: SamplerCommand) => {
  if (phase === 'start') {
    label = block;
    series = { samples: [], deltas: [], errors: [] };
    sample('start');
    timer = setInterval(() => sample('interval'), 1000);
    return;
  }
  if (block !== label) throw new Error(`diskstats sampler received an unmatched end for ${block}`);
  clearInterval(timer);
  sample('end');
  const first = series.samples[0], last = series.samples.at(-1);
  if (first?.phase === 'start' && last?.phase === 'end') {
    for (const [i, row] of first.counters.entries()) {
      try {
        for (let j = 1; j < series.samples.length; j++) {
          diskDelta(series.samples[j - 1].counters[i], series.samples[j].counters[i]);
        }
        series.deltas.push(diskDelta(row, last.counters[i]));
      } catch (error) { series.errors.push(String(error)); }
    }
  } else series.errors.push('missing start or end diskstats sample');
  send({ label, series });
});
process.on('disconnect', () => process.exit(0));
send({ placement: { pid: process.pid, cpus: allowedCpus(read('/proc/self/status')), cgroup: read('/proc/self/cgroup').trim() } });
