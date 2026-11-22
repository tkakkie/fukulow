import assert from 'node:assert/strict';
import { countKeys, type Counts, type Latency, type Step, type workload } from './search-m1-report.ts';
import type { throughputReport } from './throughput-summary.ts';

export type Snapshot = { startedMs: number; completedMs: number; walBytes: number; dbBytes: number };
export type Boundary = Snapshot | { missing: string } | undefined;
export type CpuSample = { at: number; appCpu: number; dbCpu: number };

type Conditions = ReturnType<typeof workload>;
type Throughput = ReturnType<typeof throughputReport> & Omit<Conditions, 'rates' | 'seconds'> & { bodySha256: string };
type Metric = { values: Record<string, number> };

function readSummary<T>(log: string, prefix: string): T {
  const lines = log.split('\n').filter(line => line.startsWith(prefix));
  assert.equal(lines.length, 1, `Missing or duplicate ${prefix.trim()} summary`);
  return JSON.parse(lines[0].slice(prefix.length));
}

// M1 omits resources when any sample is missing; S1 (partialResources) keeps what it has, so accepted/s stays reported.
export function collect(log: string, expected: Conditions, startMs: number | undefined,
  boundaries: Boundary[], samples: CpuSample[], partialResources = false) {
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
    if (!boundary || 'missing' in boundary) return boundary ?? { missing: `snapshot ${index} missing` };
    if (startMs === undefined) return { missing: 'host scenario start marker missing' };
    if (!Number.isSafeInteger(boundary.walBytes) || !Number.isSafeInteger(boundary.dbBytes)) {
      return { missing: `snapshot ${index} returned invalid WAL or DB size` };
    }
    if (index === 0) return boundary.completedMs > startMs ?
      { missing: `snapshot late by ${boundary.completedMs - startMs} ms` } : boundary;
    const earliest = startMs + ((index - 1) * cycle + expected.seconds) * 1000;
    const final = index === data.steps.length;
    const allowedStart = earliest + (final ? 0 : expected.requestTimeoutSeconds * 1000);
    const latest = startMs + index * cycle * 1000;
    if (!final && boundary.completedMs > latest) return { missing: `snapshot late by ${boundary.completedMs - latest} ms` };
    if (boundary.startedMs < allowedStart) return { missing: `snapshot early by ${allowedStart - boundary.startedMs} ms` };
    return boundary;
  });
  const count = (metric: string, expectedCount?: number) => {
    const value = metrics[metric]?.values?.count;
    assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `Missing or invalid count: ${metric}`);
    if (expectedCount !== undefined) assert.equal(value, expectedCount, `Inconsistent count: ${metric}`);
    return value;
  };
  const latency = (tags: string, offered: number): { sendMs: Latency; sendSamples: number } => {
    const trend = metrics[`http_req_duration{${tags}}`]?.values;
    assert.ok(trend, `Missing send latency trend: ${tags}`);
    assert.equal(trend.count, offered, `Incomplete send latency sample count: ${tags}`);
    const { med, 'p(95)': p95, 'p(99)': p99 } = trend;
    assert.ok(offered === 0 || [med, p95, p99].every(Number.isFinite), `Incomplete send latency percentiles: ${tags}`);
    return { sendMs: offered ? { p50: med, p95, p99 } : { p50: null, p95: null, p99: null }, sendSamples: trend.count };
  };
  const completeResources = (first: number, last: number, accepted: number, acceptedInWindow: number | undefined) => {
    const before = snapshots[first];
    const after = snapshots[last];
    if ('missing' in before) return { resourcesMissing: before.missing };
    if ('missing' in after) return { resourcesMissing: after.missing };
    if (startMs === undefined) return { resourcesMissing: 'host scenario start marker missing' };
    if (acceptedInWindow === undefined) return { resourcesMissing: 'in-window acceptance count missing or invalid' };
    const window = samples.filter(sample =>
      sample.at >= startMs + first * cycle * 1000 && sample.at <= after.completedMs);
    if (!window.length) return { resourcesMissing: 'CPU samples missing' };
    return { resources: { acceptedPerSecond: acceptedInWindow / ((last - first) * expected.seconds),
      walBytesPerSend: accepted ? (after.walBytes - before.walBytes) / accepted : null,
      appCpuPeakPercent: Math.max(...window.map(sample => sample.appCpu)),
      dbCpuPeakPercent: Math.max(...window.map(sample => sample.dbCpu)), dbSizeGrowthBytes: after.dbBytes - before.dbBytes } };
  };
  const resources = (first: number, last: number, accepted: number, acceptedInWindow: number | undefined) => {
    if (!partialResources) return completeResources(first, last, accepted, acceptedInWindow);
    const before = snapshots[first];
    const after = snapshots[last];
    const withSnapshots = !('missing' in before) && !('missing' in after);
    const endOffset = ((last - 1) * cycle + expected.seconds + expected.requestTimeoutSeconds) * 1000;
    const window = startMs === undefined ? [] : samples.filter(sample => sample.at >= startMs + first * cycle * 1000 &&
      sample.at <= ('missing' in after ? startMs + endOffset : after.completedMs));
    const resourcesMissing = 'missing' in before ? before.missing : 'missing' in after ? after.missing :
      startMs === undefined ? 'host scenario start marker missing' : acceptedInWindow === undefined ? 'in-window acceptance count missing or invalid' : !window.length ? 'CPU samples missing' : undefined;
    return { resourcesMissing, resources: {
      acceptedPerSecond: acceptedInWindow === undefined ? null : acceptedInWindow / ((last - first) * expected.seconds),
      walBytesPerSend: withSnapshots && accepted ? (after.walBytes - before.walBytes) / accepted : null,
      appCpuPeakPercent: window.length ? Math.max(...window.map(sample => sample.appCpu)) : null,
      dbCpuPeakPercent: window.length ? Math.max(...window.map(sample => sample.dbCpu)) : null,
      dbSizeGrowthBytes: withSnapshots ? after.dbBytes - before.dbBytes : null,
    } };
  };
  const inWindowCounts = data.steps.map(step => {
    const value = metrics[`throughput_accepted_in_window{scenario:${step.name}}`]?.values?.count;
    if (Number.isSafeInteger(value) && value >= 0 && value <= step.accepted && value === step.acceptedInWindow) return value;
  });
  const sendTags = 'name:throughput_send';
  const steps: Step[] = data.steps.map((step, index) => {
    assert.equal(step.name, `step_${index + 1}`);
    assert.equal(step.startSeconds, index * cycle);
    assert.equal(step.seconds, expected.seconds);
    const tags = `${sendTags},scenario:${step.name}`;
    const offered = count(`http_reqs{${tags}}`);
    assert.equal(offered, step.attempted, 'Incomplete HTTP request evidence');
    const perStep = (metric: string, value: number) => {
      const actual = count(`${metric}{scenario:${step.name}}`);
      assert.equal(actual, value, `Inconsistent count: ${metric}{scenario:${step.name}}`);
      return actual;
    };
    perStep('throughput_attempted', offered);
    const failedTransport = count(`http_reqs{${tags},status:0}`);
    const clientTimeouts = count(`http_reqs{${tags},status:0,error_code:1050}`);
    return { rate: step.rate, seconds: step.seconds, offered,
      droppedIterations: perStep('dropped_iterations', step.droppedIterations),
      accepted: perStep('throughput_accepted', step.accepted),
      rejected429: perStep('throughput_429', step.rejected429), rejected503: perStep('throughput_503', step.rejected503),
      otherHttpErrors: perStep('throughput_other', step.otherErrors) - failedTransport,
      clientTimeouts, transportErrors: failedTransport - clientTimeouts,
      ...latency(tags, offered), ...resources(index, index + 1, step.accepted, inWindowCounts[index]) };
  });
  const counts = Object.fromEntries(countKeys.map(key => [key, steps.reduce((total, step) => total + step[key], 0)])) as Counts;
  assert.equal(counts.offered, data.offered, 'Incomplete arm-run request evidence');
  assert.equal(counts.accepted, data.accepted, 'Incomplete arm-run acceptance evidence');
  count('dropped_iterations', counts.droppedIterations);
  const acceptedInWindow = inWindowCounts.reduce<number | undefined>((total, value) =>
    total === undefined || value === undefined ? undefined : total + value, 0);
  const totals = { ...counts, ...latency(sendTags, counts.offered), ...resources(0, steps.length, counts.accepted, acceptedInWindow) };
  return { workload, bodySha256, steps, totals };
}
