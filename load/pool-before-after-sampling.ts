import type { Activity } from './pool-before-after-db.ts';

const separator = '\n---\n';
export const k6Address = '127.0.0.1:6565';
export const generatorProbe = `cat /proc/1/stat /proc/1/status || exit 1
for metric in vus vus_max; do
  printf '\\n---\\n'
  wget -q -T 1 -O - "http://${k6Address}/v1/metrics/$metric" || :
done`;

export function processStats(raw: string) {
  const stat = raw.split('\n', 1)[0];
  if (!stat.startsWith('1 (') || !stat.includes(') ')) throw new Error('Invalid PID 1 sample');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  const rssKiB = Number(raw.match(/^VmRSS:\s+(\d+)/m)?.[1]);
  if (![cpuTicks, rssKiB].every(Number.isFinite)) throw new Error('Invalid process sample');
  return { cpuTicks, rssKiB };
}

function gauge(raw?: string): number | null {
  try {
    const value = JSON.parse(raw ?? '').data.attributes.sample.value;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function generatorStats(raw: string) {
  const [proc, active, maximum] = raw.split(separator);
  return { ...processStats(proc), vus: gauge(active), vus_max: gauge(maximum) };
}

type At<T> = T & { at: number };
type ProcessStats = ReturnType<typeof processStats>;
type ResourceSample = ProcessStats & { cpuPercent: number | null };
type SampleSource<T extends ResourceSample> = { samples: At<T>[]; errors: number[] };

export function sampler<T extends ProcessStats>(sample: () => Promise<T>) {
  const samples: At<T & { cpuPercent: number | null }>[] = [];
  const errors: number[] = [];
  let pending: Promise<void> | undefined;
  function tick() {
    if (pending) return;
    const at = Date.now();
    pending = sample().then(value => {
      const previous = samples.at(-1);
      // Linux /proc reports CPU ticks at 100 Hz. 100% represents one core.
      const elapsed = previous ? at - previous.at : 0;
      const cpuPercent = previous && elapsed > 0 && value.cpuTicks >= previous.cpuTicks
        ? (value.cpuTicks - previous.cpuTicks) * 1000 / elapsed : null;
      samples.push({ ...value, at, cpuPercent });
    }).catch(() => { errors.push(at); }).finally(() => { pending = undefined; });
  }
  tick();
  const timer = setInterval(tick, 1000);
  return { samples, errors, stop: async () => { clearInterval(timer); await pending; } };
}

function metric(values: (number | null)[]) {
  const numbers = values.filter((n): n is number => n !== null);
  return { mean: numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null,
    peak: numbers.length ? Math.max(...numbers) : null };
}

function gaps(times: number[], from: number, to: number) {
  const bounds = [from, ...times, to];
  const gaps = bounds.slice(1).map((t, i) => t - bounds[i]);
  return { samples: times.length, maxSampleGapMs: Math.max(...gaps), maxInteriorGapMs: Math.max(0, ...gaps.slice(1, -1)) };
}

export function sampleWindow<T extends ResourceSample>(
  source: SampleSource<T>, from: number, to: number,
) {
  const records = source.samples.filter(s => s.at >= from && s.at < to);
  return {
    records, ...gaps(records.map(s => s.at), from, to),
    samplingErrors: source.errors.filter(t => t >= from && t < to).length,
    cpuPercent: metric(records.map(s => s.cpuPercent)), rssKiB: metric(records.map(s => s.rssKiB)),
  };
}

export function generatorWindow(source: SampleSource<ReturnType<typeof generatorStats> & ResourceSample>,
  from: number, to: number, vusLimit: number,
) {
  const { records, ...resources } = sampleWindow(source, from, to);
  const summarize = (name: 'cpuPercent' | 'vus' | 'vus_max') => ({
    ...metric(records.map(s => s[name])), ...gaps(records.filter(s => s[name] !== null).map(s => s.at), from, to),
  });
  return { ...resources, cpuPercent: summarize('cpuPercent'), vus: summarize('vus'), vus_max: summarize('vus_max'),
    reachedMaxVUs: records.some(s => s.vus !== null && s.vus >= vusLimit) };
}

export function activityWindow(records: Activity[]) {
  const states = [...new Set(records.flatMap(s => Object.keys(s.states)))].sort();
  return {
    dbConnectionsInUse: metric(records.map(s => s.connections)),
    dbActive: metric(records.map(s => s.active)),
    blockedBackends: metric(records.map(s => s.blocked)),
    states: Object.fromEntries(states.map(state => [state, metric(records.map(s => s.states[state] ?? 0))])),
    transactionAgeMs: Object.fromEntries((['nonIdle', 'idleInTransaction'] as const).map(kind => {
      const holds = records.map(s => s.holds[kind]).filter(h => h !== undefined);
      const observations = holds.reduce((total, h) => total + h.count, 0);
      return [kind, { observations, mean: observations ? holds.reduce((total, h) => total + (h.mean ?? 0) * h.count, 0) / observations : null,
        peak: metric(holds.map(h => h.peak)).peak }];
    })),
  };
}
