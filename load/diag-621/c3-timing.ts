import { periodMs, tmpfsBytes, type Tick } from './c3-observer.ts';
import type { Load } from './validity.ts';

export type Request = { id: number; vu: number; start: number; end: number; latency: number; status: number };
export type Traffic = { scenario: number; requests: Request[]; vus: { wallMs: number; value: number }[]; load: Load };
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function loadBoundaries(warm: Traffic, measured: Traffic) {
  const start = Math.min(...warm.requests.map(row => row.start));
  const first = Math.min(...measured.requests.map(row => row.start));
  const last = Math.max(...measured.requests.map(row => row.end));
  if (![start, first, last].every(Number.isFinite) || Math.max(...warm.requests.map(row => row.end)) > measured.scenario) {
    throw new Error('warm-up and measured request clocks do not agree');
  }
  return { start, first, last };
}

export function trafficReasons(traffic: Traffic, measured: boolean) {
  const { requests, scenario, load, vus } = traffic;
  if (!count(scenario) || scenario === 0 || !Array.isArray(requests) || !requests.length || new Set(requests.map(row => row.id)).size !== requests.length
    || requests.some(row => !count(row.id) || !count(row.vu) || row.vu < 1 || row.vu > 200 || !count(row.start)
      || !count(row.end) || row.end < row.start || row.start < scenario || !Number.isFinite(row.latency) || row.latency < 0
      || row.latency > row.end - row.start + 2 || !count(row.status))) return ['request, latency or VU evidence missing or malformed'];
  const accepted = requests.filter(row => row.status === 201).length;
  const why: string[] = [];
  if (load.accepted !== accepted || load.attempts !== requests.length || load.iterations !== requests.length
    || load.errors !== requests.length - accepted || !count(load.dropped)) why.push('k6 counts do not reconcile');
  if (measured && (load.errors !== 0 || load.dropped !== 0 || ![2000, 2001].includes(load.accepted))) {
    why.push('measured errors, drops or accepted count outside plan');
  }
  if (measured && (!Array.isArray(vus) || !vus.length || vus.some(row => !Number.isFinite(row.wallMs) || !count(row.value) || row.value > 200)
    || !vus.some(row => row.wallMs >= scenario && row.wallMs <= Math.max(...requests.map(row => row.end)) + 1000 && row.value > 0))) {
    why.push('k6 VU samples missing or malformed');
  }
  return why;
}

export function storageReason(used: number[]) {
  if (!used.length || used.some(value => !count(value) || value > tmpfsBytes)) return 'tmpfs samples missing or malformed';
  return Math.max(...used) > tmpfsBytes * 0.9 ? 'tmpfs exceeded 90% of 2 GiB' : undefined;
}

export function storageCoverage(samples: Tick[], finishedAt: number) {
  return samples.length >= 2 && samples.at(-1)!.wallMs >= finishedAt - 250
    && samples.slice(1).every((row, index) => row.monoMs > samples[index].monoMs && row.monoMs - samples[index].monoMs <= 250);
}

const rate = (left: Tick, right: Tick, key: 'app' | 'db') => (right[key] - left[key]) / (right.monoMs - left.monoMs);

function bracket(ticks: Tick[], at: number) {
  const index = ticks.findIndex(row => row.monoMs >= at);
  if (index < 1) throw new Error('CPU samples do not bracket load boundaries');
  return [ticks[index - 1], ticks[index]] as const;
}

const interpolate = (ticks: Tick[], at: number, key: 'app' | 'db') => {
  const [left, right] = bracket(ticks, at);
  return left[key] + rate(left, right, key) * (at - left.monoMs);
};

export class DrainPending extends Error {}

function drain(ticks: Tick[], last: number) {
  let since: number | undefined;
  for (const [index, right] of ticks.slice(1).entries()) {
    if (right.monoMs <= last) continue;
    const left = ticks[index];
    if (rate(left, right, 'app') >= 10) since = undefined;
    else {
      since ??= Math.max(left.monoMs, last);
      if (right.monoMs >= since + 200 && since + 200 - last <= 2000) return since + 200;
    }
    if (right.monoMs >= last + 2000) break;
  }
  if (ticks.at(-1)!.monoMs < last + 2000) throw new DrainPending('app drain still being sampled');
  throw new Error('app drain did not complete within 2 s');
}

export function cpuWindow(ticks: Tick[], warmStart: number, first: number, last: number) {
  if (!Array.isArray(ticks) || ticks.length < 3 || ticks.some(row => !Number.isFinite(row.monoMs) || !Number.isFinite(row.wallMs)
    || !Number.isFinite(row.spanMs) || row.spanMs < 0 || row.spanMs > periodMs || !count(row.app) || !count(row.db))) {
    throw new Error('cgroup CPU samples missing or malformed');
  }
  const offsetMs = ticks[0].monoMs - ticks[0].wallMs;
  if (ticks.some(row => Math.abs(row.monoMs - row.wallMs - offsetMs) > 5 + (ticks[0].spanMs + row.spanMs) / 2)) {
    throw new Error('Docker host wall-to-monotonic clock offset drift');
  }
  for (const [index, right] of ticks.slice(1).entries()) {
    const left = ticks[index];
    if (right.monoMs <= left.monoMs || right.app < left.app || right.db < left.db) throw new Error('CPU counter or clock regressed');
  }
  if (!(ticks[0].monoMs < warmStart + offsetMs && warmStart < first && first < last)) throw new Error('CPU samples do not cover warm-up');
  const start = first + offsetMs, responseEnd = last + offsetMs;
  if (ticks.at(-1)!.monoMs <= responseEnd) throw new DrainPending('CPU samples do not bracket the last response yet');
  if (ticks.slice(1).some((right, index) => ticks[index].monoMs <= responseEnd && right.monoMs - ticks[index].monoMs > 250)) {
    throw new Error('CPU sampler gap exceeded 250 ms');
  }
  const end = drain(ticks, responseEnd);
  if (ticks.at(-1)!.monoMs <= end) throw new DrainPending('CPU samples do not cover after drain yet');
  const relevant = ticks.slice(1).flatMap((right, index) => {
    const left = ticks[index];
    return left.monoMs <= end ? [[left, right] as const] : [];
  });
  if (relevant.some(([left, right]) => right.monoMs - left.monoMs > 250)) throw new Error('CPU sampler gap exceeded 250 ms');
  const measure = (key: 'app' | 'db') => ({ usec: interpolate(ticks, end, key) - interpolate(ticks, start, key),
    errorUsec: 2 * periodMs * Math.max(...relevant.map(([left, right]) => rate(left, right, key))) });
  return { offsetMs, start, end, drainMs: end - responseEnd, endWallMs: end - offsetMs, app: measure('app'), db: measure('db') };
}

function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * fraction, low = Math.floor(index);
  return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
}

export function latency(requests: Request[], first: number) {
  const accepted = requests.filter(row => row.status === 201);
  const stats = (rows: Request[]) => {
    if (!rows.length) throw new Error('latency segment missing');
    const usec = rows.map(row => row.latency * 1000);
    return { count: rows.length, p50: quantile(usec, 0.5), p95: quantile(usec, 0.95) };
  };
  return { all: stats(accepted), firstSecond: stats(accepted.filter(row => row.start < first + 1000)),
    rest: stats(accepted.filter(row => row.start >= first + 1000)) };
}
