// #469: per-step app-side evidence from the app's existing structured events (server/src/observability.rs,
// server/src/database/stats.rs). Only allowlisted aggregates leave this module: never a raw line, request
// path, Account, credential or Message body. Missing or broken evidence is reported as incomplete.
const poolCounters = ['acquire_success', 'acquire_timeout', 'acquire_closed', 'acquire_io', 'acquire_database', 'acquire_other',
  'acquire_cancelled', 'wait_le_1000000_us', 'wait_count'] as const;
const failureKinds = ['pool_timeout', 'pool_closed', 'deadline', 'io', 'database', 'other'] as const;
// observability::close_bucket: server-sent codes, plus the peer/transport end the server did not choose.
const closeCodes = ['1001', '1011', '4001', '4003', '4008', '4029', 'other', 'peer_or_transport'] as const;
const sampleSlackMs = 2000;
const seriesLimit = 900;

type Close = { count: number; firstMs: number | null; lastMs: number | null; perSecond: [number, number][] };
export type AppEvidence = {
  complete: boolean; reasons: string[]; windowMs: number;
  pool: { samples: number; maxInUse: number; minIdle: number; maxWaiting: number;
    deltas: Record<(typeof poolCounters)[number], number>; acquireWaitsOver1s: number } | null;
  databaseFailures: Record<(typeof failureKinds)[number], number>;
  closes: Record<(typeof closeCodes)[number], Close>;
  sockets: { opened: number; disconnected: number; peakConcurrent: number; peakOpenedPerSecond: number;
    openedPerSecond: number | null };
  http5xx: number;
  /** Panic lines carry no timestamp (observability::init hook): counted over the whole app log. */
  panics: number;
  /** Other WARN/ERROR app events in the window, by event name (code constants, never data). */
  otherWarnings: Record<string, number>;
};

type Row = { at: number; level: unknown; fields: Record<string, unknown>; span?: Record<string, unknown> };
function parse(line: string): Row | undefined {
  try {
    const row = JSON.parse(line);
    const at = Date.parse(row?.timestamp);
    if (row?.target !== 'fukulow' || typeof row.fields?.event !== 'string' || !Number.isFinite(at)) return;
    return { at, level: row.level, fields: row.fields, span: row.span };
  } catch { return; }
}
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : NaN;

export function appEvidence(log: string, startedAt: number, endedAt: number, readError?: string): AppEvidence {
  const reasons: string[] = readError ? [readError] : [];
  const databaseFailures = Object.fromEntries(failureKinds.map(kind => [kind, 0])) as AppEvidence['databaseFailures'];
  const opened: number[] = [];
  const closeTimes = Object.fromEntries(closeCodes.map(code => [code, [] as number[]])) as Record<(typeof closeCodes)[number], number[]>;
  const otherWarnings: Record<string, number> = {};
  let active = 0, activeAtStart = 0, peakConcurrent = 0, disconnected = 0, http5xx = 0, panics = 0;
  const samples: Row[] = [];
  if (!(endedAt > startedAt)) reasons.push('invalid generator window');
  const inWindow = (at: number) => at >= startedAt && at <= endedAt;
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    if (/"event":"panic"/.test(line)) { panics++; continue; }
    const row = parse(line);
    // Other targets are disabled in the app; an unreadable app line may be lost evidence.
    if (!row) { if (/"target":"fukulow"|pool_stats|database_failure|websocket_|http_completed/.test(line)) reasons.push('unparseable app event line'); continue; }
    const event = row.fields.event as string;
    if (event === 'pool_stats') { samples.push(row); continue; }
    // Process-wide concurrency includes sockets opened before the window; count every transition.
    if (row.at < startedAt) {
      if (event === 'websocket_opened') active++;
      if (event === 'websocket_disconnected') active--;
      activeAtStart = peakConcurrent = Math.max(0, active);
      continue;
    }
    if (!inWindow(row.at)) continue;
    if (event === 'websocket_opened') { active++; opened.push(row.at); peakConcurrent = Math.max(peakConcurrent, active); }
    else if (event === 'websocket_disconnected') { active--; disconnected++; }
    else if (event === 'websocket_closed') {
      const code = closeCodes.find(code => code === row.fields.code);
      if (code) closeTimes[code].push(row.at - startedAt); else reasons.push('unknown websocket_closed code');
    } else if (event === 'database_failure') {
      const kind = failureKinds.find(kind => kind === row.fields.kind);
      if (kind) databaseFailures[kind]++; else reasons.push('unknown database_failure kind');
    } else if (event === 'http_completed') { if (Number(row.span?.status) >= 500) http5xx++; }
    else if ((row.level === 'WARN' || row.level === 'ERROR') && /^[a-z0-9_]{1,64}$/.test(event)) otherWarnings[event] = (otherWarnings[event] ?? 0) + 1;
    else if (row.level === 'WARN' || row.level === 'ERROR') reasons.push('unrecognised app warning event');
  }
  // Worker threads format timestamps before taking the stderr lock: lines can be slightly out of order.
  const closes = Object.fromEntries(closeCodes.map(code => [code, closeSeries(closeTimes[code].sort((a, b) => a - b), reasons)])) as AppEvidence['closes'];
  const pool = poolEvidence(samples, startedAt, endedAt, reasons);
  opened.sort((a, b) => a - b);
  let peakOpenedPerSecond = 0;
  for (let i = 0, j = 0; i < opened.length; i++) {
    while (opened[i] - opened[j] >= 1000) j++;
    peakOpenedPerSecond = Math.max(peakOpenedPerSecond, i - j + 1);
  }
  const span = opened.length > 1 ? opened.at(-1)! - opened[0] : 0;
  return { complete: reasons.length === 0, reasons: [...new Set(reasons)], windowMs: endedAt - startedAt, pool, databaseFailures, closes,
    sockets: { opened: opened.length, disconnected, peakConcurrent: Math.max(peakConcurrent, activeAtStart), peakOpenedPerSecond,
      openedPerSecond: span > 0 ? Math.round(opened.length / (span / 1000)) : null },
    http5xx, panics, otherWarnings };
}

function closeSeries(times: number[], reasons: string[]): Close {
  const perSecond: [number, number][] = [];
  for (const ms of times) {
    const second = Math.floor(ms / 1000), last = perSecond.at(-1);
    if (last?.[0] === second) last[1]++;
    else if (perSecond.length < seriesLimit) perSecond.push([second, 1]);
    else { reasons.push('close series limit exceeded'); break; }
  }
  return { count: times.length, firstMs: times[0] ?? null, lastMs: times.at(-1) ?? null, perSecond };
}

// The fresh stack's first sample is sequence 1: a later first sample means rotation or a restart lost evidence.
function poolEvidence(samples: Row[], startedAt: number, endedAt: number, reasons: string[]): AppEvidence['pool'] {
  if (!samples.length) { reasons.push('missing pool_stats'); return null; }
  const sequence = (row: Row) => count(row.fields.sample_sequence);
  let broken = false;
  if (sequence(samples[0]) !== 1) { reasons.push('pool_stats does not start at sequence 1 (log rotation or app restart)'); broken = true; }
  for (let i = 1; i < samples.length; i++) {
    // Timestamps have 1 ms resolution: two ticks may share one; the sequence is the order.
    if (sequence(samples[i]) !== sequence(samples[i - 1]) + 1 || samples[i].at < samples[i - 1].at) {
      reasons.push('pool_stats sequence gap or restart'); broken = true; break;
    }
  }
  const first = samples.findLastIndex(row => row.at <= startedAt);
  const last = samples.findIndex(row => row.at >= endedAt);
  if (first < 0 || startedAt - samples[first].at > sampleSlackMs) { reasons.push('no pool_stats sample within 2 s before the window'); broken = true; }
  if (last < 0 || samples[last].at - endedAt > sampleSlackMs) { reasons.push('no pool_stats sample within 2 s after the window'); broken = true; }
  // Deltas across a restart or a missing edge would mix processes or windows.
  if (broken) return null;
  const rows = samples.slice(first, last + 1);
  const values = (key: string) => rows.map(row => count(row.fields[key]));
  const deltas = Object.fromEntries(poolCounters.map(key => [key, count(rows.at(-1)!.fields[key]) - count(rows[0].fields[key])])) as Record<(typeof poolCounters)[number], number>;
  const all = [...values('in_use'), ...values('idle'), ...values('waiting'), ...Object.values(deltas)];
  if (all.some(value => !Number.isFinite(value) || value < 0)) { reasons.push('invalid pool_stats fields'); return null; }
  return { samples: rows.length, maxInUse: Math.max(...values('in_use')), minIdle: Math.min(...values('idle')),
    maxWaiting: Math.max(...values('waiting')), deltas, acquireWaitsOver1s: deltas.wait_count - deltas.wait_le_1000000_us };
}

// Positive proxy-side evidence: counts of the proxy's own log lines at error level or above in the window.
// Only level counts are kept, never the message (it can name paths or addresses). nginx logs to stderr at warn
// and above (deploy/nginx.conf) with second-resolution UTC times; Caddy logs JSON with a `ts` epoch in seconds.
const errorLevels = { nginx: ['error', 'crit', 'alert', 'emerg'], caddy: ['error', 'panic', 'fatal'] } as const;
export type ProxyEvidence = { complete: boolean; reasons: string[]; levels: Record<string, number>; errorLines: number };
export function proxyEvidence(log: string, proxy: 'caddy' | 'nginx', startedAt: number, endedAt: number, readError?: string): ProxyEvidence {
  const reasons: string[] = readError ? [readError] : [];
  const levels: Record<string, number> = {};
  // nginx times are whole seconds: an entry in the start second may precede the run. An error-level entry there
  // cannot be placed, so it makes the evidence incomplete (cause unknown) instead of naming the proxy.
  const first = proxy === 'nginx' ? Math.floor(startedAt / 1000) * 1000 : startedAt;
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    let at: number, level: string | undefined;
    if (proxy === 'nginx') {
      const match = line.match(/^(\d{4})\/(\d\d)\/(\d\d) (\d\d:\d\d:\d\d) \[([a-z]+)\]/);
      if (!match) continue; // continuation or entrypoint output, not an nginx log entry
      at = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}Z`); level = match[5];
    } else {
      try { const row = JSON.parse(line); at = Number(row.ts) * 1000; level = typeof row.level === 'string' ? row.level : undefined; }
      catch { continue; }
    }
    if (!Number.isFinite(at) || !level || !/^[a-z]{1,8}$/.test(level)) { reasons.push('unparseable proxy log entry'); continue; }
    if (at < first || at > endedAt) continue;
    if (at < startedAt && (errorLevels[proxy] as readonly string[]).includes(level)) {
      reasons.push('proxy error in the start second cannot be placed in the window'); continue;
    }
    levels[level] = (levels[level] ?? 0) + 1;
  }
  const errorLines = (errorLevels[proxy] as readonly string[]).reduce((sum, level) => sum + (levels[level] ?? 0), 0);
  return { complete: reasons.length === 0, reasons: [...new Set(reasons)], levels, errorLines };
}
