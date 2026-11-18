import assert from 'node:assert/strict';
import { countKeys, type Counts, type Latency, type Step, type workload } from './search-m1-report.ts';
import type { throughputReport } from './throughput-summary.ts';

export type Snapshot = { startedMs: number; completedMs: number; walBytes: number; dbBytes: number };
export type CpuSample = { at: number; appCpu: number; dbCpu: number };

type Conditions = ReturnType<typeof workload>;
type Throughput = ReturnType<typeof throughputReport> & Omit<Conditions, 'rates' | 'seconds'> & { bodySha256: string };
type Metric = { values: Record<string, number> };

function readSummary<T>(log: string, prefix: string): T {
  const lines = log.split('\n').filter(line => line.startsWith(prefix));
  assert.equal(lines.length, 1, `Missing or duplicate ${prefix.trim()} summary`);
  return JSON.parse(lines[0].slice(prefix.length));
}

export function collect(log: string, expected: Conditions, startMs: number,
  boundaries: (Snapshot | undefined)[], samples: CpuSample[]) {
  const data = readSummary<Throughput>(log, 'LOAD_THROUGHPUT ');
  const { metrics } = readSummary<{ metrics: Record<string, Metric> }>(log, 'LOAD_SUMMARY ');
  const { mode, channels, members, subscribers, preAllocatedVUs, maxVUs, requestTimeoutSeconds, bodySha256 } = data;
  const workload = { mode, channels, members, subscribers, preAllocatedVUs, maxVUs, requestTimeoutSeconds,
    rates: data.steps.map(step => step.rate), seconds: data.steps[0]?.seconds };
  assert.deepEqual(workload, expected, 'k6 workload mismatch');
  assert.match(bodySha256, /^[a-f0-9]{64}$/);
  const cycle = expected.seconds + expected.requestTimeoutSeconds + 1;
  const snapshots = Array.from({ length: data.steps.length + 1 }, (_, index) => {
    const boundary = boundaries[index];
    if (!boundary || !Number.isSafeInteger(boundary.walBytes) || !Number.isSafeInteger(boundary.dbBytes)) return;
    if (index === 0) return boundary.completedMs <= startMs ? boundary : undefined;
    const earliest = startMs + ((index - 1) * cycle + expected.seconds) * 1000;
    if (index === data.steps.length) return boundary.startedMs >= earliest ? boundary : undefined;
    const latest = startMs + index * cycle * 1000;
    if (boundary.startedMs >= earliest + expected.requestTimeoutSeconds * 1000 && boundary.completedMs <= latest) return boundary;
  });
  const value = (name: string, tags: string, stat: string) => metrics[`${name}{${tags}}`]?.values[stat];
  const count = (name: string, tags: string) => value(name, tags, 'count') ?? 0;
  const latency = (tags: string, offered: number): Latency => ({
    p50: offered ? value('http_req_duration', tags, 'med') ?? null : null,
    p95: offered ? value('http_req_duration', tags, 'p(95)') ?? null : null,
    p99: offered ? value('http_req_duration', tags, 'p(99)') ?? null : null,
  });
  const resources = (first: number, last: number, accepted: number, acceptedInWindow: number) => {
    const before = snapshots[first];
    const after = snapshots[last];
    if (!before || !after) return;
    const window = samples.filter(sample =>
      sample.at >= startMs + first * cycle * 1000 && sample.at <= after.completedMs);
    if (!window.length) return;
    return { acceptedPerSecond: acceptedInWindow / ((last - first) * expected.seconds),
      walBytesPerSend: accepted ? (after.walBytes - before.walBytes) / accepted : null,
      appCpuPeakPercent: Math.max(...window.map(sample => sample.appCpu)),
      dbCpuPeakPercent: Math.max(...window.map(sample => sample.dbCpu)), dbSizeGrowthBytes: after.dbBytes - before.dbBytes };
  };
  const sendTags = 'name:throughput_send';
  const steps: Step[] = data.steps.map((step, index) => {
    assert.equal(step.name, `step_${index + 1}`);
    assert.equal(step.startSeconds, index * cycle);
    assert.equal(step.seconds, expected.seconds);
    const tags = `${sendTags},scenario:${step.name}`;
    const offered = count('http_reqs', tags);
    assert.equal(offered, step.attempted, 'Incomplete HTTP request evidence');
    assert.ok(Number.isSafeInteger(step.acceptedInWindow) && step.acceptedInWindow >= 0 &&
      step.acceptedInWindow <= step.accepted, 'Incomplete in-window acceptance evidence');
    const failedTransport = count('http_reqs', `${tags},status:0`);
    const clientTimeouts = count('http_reqs', `${tags},status:0,error_code:1050`);
    return { rate: step.rate, seconds: step.seconds, offered, droppedIterations: step.droppedIterations,
      accepted: step.accepted, rejected429: step.rejected429, rejected503: step.rejected503,
      otherHttpErrors: step.otherErrors - failedTransport, clientTimeouts, transportErrors: failedTransport - clientTimeouts,
      sendMs: latency(tags, offered), resources: resources(index, index + 1, step.accepted, step.acceptedInWindow) };
  });
  const counts = Object.fromEntries(countKeys.map(key => [key, steps.reduce((total, step) => total + step[key], 0)])) as Counts;
  assert.equal(counts.offered, data.offered, 'Incomplete arm-run request evidence');
  assert.equal(counts.accepted, data.accepted, 'Incomplete arm-run acceptance evidence');
  assert.equal(counts.droppedIterations, metrics.dropped_iterations?.values.count ?? 0, 'Incomplete dropped iteration evidence');
  const totals = { ...counts, sendMs: latency(sendTags, counts.offered), resources: resources(0, steps.length,
    counts.accepted, data.steps.reduce((sum, step) => sum + step.acceptedInWindow, 0)) };
  return { workload, bodySha256, steps, totals };
}
