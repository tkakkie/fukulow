import type { Arm } from '../../slice5/config.ts';
import type { Mode } from '../../harness-core/stages.ts';
import { quantiles } from '../515-replay/measure.ts';
import type { Variant } from './images.ts';

export const prefix = 'FK515_APP ';
type Span = { label: string; index: number | null; start: number; end: number };
export const sqlLabels = {
  A: ['auth_begin', 'auth_context', 'session', 'auth_rollback', 'visibility',
    'watermark_begin', 'barrier', 'watermark', 'watermark_commit', 'page'],
  B: ['auth_begin', 'auth_context', 'session', 'auth_rollback', 'history_begin',
    'history_context', 'visibility', 'page', 'history_rollback'],
} as const;
const acquireLabels = { A: ['auth', 'visibility', 'watermark', 'page'], B: ['auth', 'history'] };
const snapshotLabels = ['snapshot_begin', 'snapshot_context', 'snapshot_end'];
const authLabels = new Set<string>(sqlLabels.A.slice(0, 4));
const auxLabels = ['acquire', 'permit', 'connect', 'checkout', 'return', 'decode', 'page_decode', 'request', 'handler', 'response'];
const observedLabels = new Set([...sqlLabels.A, ...sqlLabels.B, ...snapshotLabels, ...auxLabels]);

export function parseTraces(log: string) {
  const traces = new Map<number, Span[]>();
  for (const line of log.split('\n')) {
    if (!line.startsWith(prefix)) continue;
    const raw: unknown = JSON.parse(line.slice(prefix.length));
    if (!Array.isArray(raw) || raw.length !== 2 || !natural(raw[0]) || traces.has(raw[0]) || !Array.isArray(raw[1])) {
      throw new Error('Invalid or duplicate trace ID');
    }
    const events = raw[1].map((event: unknown) => {
      if (!Array.isArray(event) || event.length !== 4) throw new Error('Invalid trace span');
      const [label, index, start, end] = event;
      if (!observedLabels.has(label)
        || (label === 'return' ? !natural(index) : index !== null)
        || !natural(start) || !natural(end) || end < start) throw new Error('Invalid trace span');
      return { label, index, start, end } as Span;
    });
    traces.set(raw[0], events);
  }
  return traces;
}

function natural(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}
const contains = (a: Span, b: Span) => a.start <= b.start && a.end >= b.end;
const duration = (s: Span) => s.end - s.start;
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const sorted = (v: Span[]) => [...v].sort((a, b) => a.start - b.start);
const disjoint = (v: Span[]) => sorted(v).every((s, i, list) => i === 0 || list[i - 1].end <= s.start);

function overlap(window: Span, spans: Span[]) {
  let end = window.start;
  let total = 0;
  for (const s of sorted(spans)) {
    const from = Math.max(window.start, s.start, end);
    const to = Math.min(window.end, s.end);
    if (to > from) {
      total += to - from;
      end = to;
    }
  }
  return total;
}

export function components(arm: Arm, spans: Span[], httpMs: number) {
  const all = (label: string) => sorted(spans.filter(s => s.label === label));
  const one = (label: string) => {
    const [s, extra] = all(label);
    if (!s || extra) throw new Error('Expected one ' + label + ' span');
    return s;
  };
  const request = one('request'), handler = one('handler'), response = one('response');
  const acquires = all('acquire'), returns = all('return');
  const sql = sorted(spans.filter(s => !auxLabels.includes(s.label)));
  const checkout = all('checkout'), permits = all('permit'), connections = all('connect');
  const pageDecode = all('page_decode'), decode = all('decode');
  const names = sqlLabels[arm];
  const rawNames = names.map(name => ['auth', 'history'].includes(name.split('_')[0])
    ? name.endsWith('_begin') ? 'snapshot_begin' : name.endsWith('_context') ? 'snapshot_context' : 'snapshot_end'
    : name);
  const paths = acquireLabels[arm];
  if (sql.length !== names.length || sql.some((s, i) => s.label !== rawNames[i]) ||
    acquires.length !== paths.length || returns.length !== paths.length ||
    !returns.every(s => s.index! < paths.length && acquires[s.index!].end <= s.start) ||
    new Set(returns.map(s => s.index)).size !== paths.length) throw new Error('Unexpected SQL or pool path');

  if (!contains(request, handler) || !contains(handler, response) ||
    [...acquires, ...sql, ...pageDecode, response].some(s => !contains(request, s)) ||
    !disjoint([...acquires, ...sql, ...pageDecode, response]) ||
    [...checkout, ...permits, ...connections].some(s => !acquires.some(a => contains(a, s))) ||
    !disjoint([...checkout, ...permits, ...connections]) ||
    decode.some(s => !sql.some(q => contains(q, s))) || !disjoint(decode) ||
    pageDecode.length !== (arm === 'A' ? 1 : 0) ||
    !Number.isFinite(httpMs) || httpMs < duration(request) / 1e6) throw new Error('Inconsistent latency spans');

  const out: Record<string, number> = {};
  const put = (label: string, ns: number) => { out[label] = ns / 1e6; };
  acquires.forEach((a, i) => {
    const name = paths[i];
    const owned = (items: Span[]) => items.filter(s => contains(a, s));
    const ns = (items: Span[]) => sum(owned(items).map(duration));
    const checkNs = ns(checkout);
    put('acquire.' + name, duration(a));
    put('acquire_without_check.' + name, duration(a) - checkNs);
    put('permit.' + name, ns(permits));
    put('connect.' + name, ns(connections));
    put('checkout.' + name, checkNs);
    put('return.' + name, duration(returns.find(s => s.index === i)!));
    put('return_overlap_permit.' + name, sum(owned(permits).map(p => overlap(p, returns))));
  });
  let nonPageSql = 0;
  let sqlNs = 0;
  sql.forEach((s, i) => {
    const name = names[i];
    const decodeNs = sum(decode.filter(d => contains(s, d)).map(duration));
    const wireNs = duration(s) - decodeNs;
    put('sql.' + name, wireNs);
    put('decode.' + name, decodeNs + (name === 'page' ? sum(pageDecode.map(duration)) : 0));
    sqlNs += wireNs;
    if (name !== 'page' && !authLabels.has(name)) nonPageSql += wireNs;
  });
  const acquireNs = sum(acquires.map(duration));
  const checkNs = sum(checkout.map(duration));
  const decodeNs = sum([...decode, ...pageDecode].map(duration));
  const accounted = acquireNs + sqlNs + decodeNs + duration(response);
  put('pool_acquire_total', acquireNs);
  put('pool_acquire_without_checks', acquireNs - checkNs);
  put('pool_permit_total', sum(permits.map(duration)));
  put('pool_checkout_total', checkNs);
  put('sql_total', sqlNs);
  put('replay_nonpage_sql', nonPageSql);
  put('sync_check_and_nonpage_sql', checkNs + nonPageSql);
  put('decode_total', decodeNs);
  put('response', duration(response));
  put('handler', duration(handler));
  put('request', duration(request));
  put('component_sum', accounted);
  put('unmeasured_app', duration(request) - accounted);
  put('async_return_total', sum(returns.map(duration)));
  put('async_return_overlap_request', overlap(request, returns));
  put('async_return_overlap_permits', sum(permits.map(p => overlap(p, returns))));
  out.http = httpMs;
  out.unexplained = httpMs - out.component_sum;
  return { values: out, counts: { sql: sql.length, checkout: checkout.length, return: returns.length, connect: connections.length } };
}

export type ClientSample = { id: number; after: number; warmup: boolean; httpMs: number };
export type Sample = ClientSample & { trace?: ReturnType<typeof components> };
export type Block = { arm: Arm; cell: string; variant: Variant; block: number; samples: Sample[] };

const fixed = (x: number) => x.toFixed(3);
const delta = (a: number, b: number) => fixed(a - b);
const ranks = [0.5, 0.95];
function atHttpRank(samples: Sample[], rank: number) {
  const rows = [...samples].sort((a, b) => a.httpMs - b.httpMs || a.id - b.id);
  return rows[Math.ceil(rows.length * rank) - 1];
}

export function summary(mode: Mode, blocks: Block[], complete: boolean) {
  const lines = ['# #515 REST replay app-path diagnostic', '',
    mode === 'recorded' ? '**Recorded diagnostic.**' : `**${mode.toUpperCase()} validation only. Never evidence.**`,
    '', 'This diagnostic gives no PASS/FAIL and changes neither the night 3 result (3 FAIL, 1 INVALID) nor any threshold.',
    '', 'Night 3 observed an HTTP p95 gap of about 0.8–1.1 ms. The settled fixture here has one sequential reader and no writer.',
    'SQL time excludes observed Rust decoding. Pool acquire time includes checkout checks and may include connection establishment. Permit wait is contained within acquire time.',
    'The synchronous trip comparison combines checkout checks with replay SQL other than the page. This contrasts five A statements with four B statements, plus the checkout checks in both arms. It is a measured group difference that includes statement execution.',
    'Asynchronous return checks retain their existing SQLx scheduling. Their elapsed time and overlap with the same request and its pool permit waits are shown separately. Their causal contribution to HTTP latency is not identified.',
    'Individual component percentiles are marginal. The component sum is calculated within each request from SQL, pool acquire, decoding and response generation.',
    'The unexplained remainder is not identified.', ''];
  if (!complete) return [...lines, 'Run incomplete. See status.json and raw block files for completed observations.', ''].join('\n');
  if (!blocks.length) throw new Error('No timing blocks');
  const cells = [...new Set(blocks.map(b => b.cell))];
  for (const cell of cells) {
    const rows = (arm: Arm, variant: Variant) => blocks
      .filter(b => b.arm === arm && b.cell === cell && b.variant === variant)
      .flatMap(b => b.samples.filter(s => !s.warmup));
    const a = rows('A', 'patched'), b = rows('B', 'patched');
    const ca = rows('A', 'control'), cb = rows('B', 'control');
    if (!a.length || ![b, ca, cb].every(r => r.length === a.length)
      || [...a, ...b].some(s => !s.trace) || [...ca, ...cb].some(s => s.trace)) throw new Error('Missing or mismatched timing samples');
    const schedule = (r: Sample[]) => r.map(s => s.after).join(',');
    if (![b, ca, cb].every(r => schedule(r) === schedule(a))) throw new Error('Mismatched cursor schedules');
    const armValues = (r: Sample[], name: string) => r.map(s => s.trace!.values[name] ?? 0);
    const labels = [...new Set([a[0], b[0]].flatMap(s => Object.keys(s.trace!.values)))];
    lines.push(`## ${cell}`, '', `${a.length} measured requests per arm and variant.`, '',
      '| Component (ms) | A p50 / p95 | B p50 / p95 | A − B p50 / p95 |',
      '|---|---:|---:|---:|');
    const add = (name: string, aa: number[], bb: number[]) => {
      const aq = quantiles(aa), bq = quantiles(bb);
      lines.push(`| ${name} | ${fixed(aq.p50)} / ${fixed(aq.p95)} | ${fixed(bq.p50)} / ${fixed(bq.p95)} | ${delta(aq.p50, bq.p50)} / ${delta(aq.p95, bq.p95)} |`);
    };
    for (const label of labels) add(label, armValues(a, label), armValues(b, label));
    add('http (unpatched control)', ca.map(s => s.httpMs), cb.map(s => s.httpMs));
    lines.push('', 'Missing arm-specific statement or acquire slots are shown as zero.',
      'The patched and control runs use independent stacks; their HTTP gap shift is an empirical overhead check that includes run-to-run variation.', '');
    for (const [name, patched, control] of [['A', a, ca], ['B', b, cb]] as const) {
      const p = quantiles(patched.map(s => s.httpMs)), c = quantiles(control.map(s => s.httpMs));
      const paths = new Set(patched.map(s => JSON.stringify(s.trace!.counts)));
      lines.push(`- ${name} patched HTTP percentile minus control percentile was ${delta(p.p50, c.p50)} ms at p50 and ${delta(p.p95, c.p95)} ms at p95. Observed per-request counts ${[...paths].join(', ')}.`);
    }
    const httpGap = (aa: Sample[], bb: Sample[], rank: number) => atHttpRank(aa, rank).httpMs - atHttpRank(bb, rank).httpMs;
    lines.push(`- The A − B HTTP gap shifted by ${fixed(httpGap(a, b, 0.5) - httpGap(ca, cb, 0.5))} ms at p50 and ${fixed(httpGap(a, b, 0.95) - httpGap(ca, cb, 0.95))} ms at p95 with instrumentation.`,
      '', 'Each row below uses the actual observation at that HTTP percentile in each arm. The synchronous trip group is contained in the component sum. Asynchronous checks are excluded from that sum.', '',
      '| HTTP rank | A − B HTTP (ms) | A − B component sum (ms) | A − B unexplained (ms) | A − B synchronous trip group (ms) |',
      '|---|---:|---:|---:|---:|');
    for (const rank of ranks) {
      const aa = atHttpRank(a, rank).trace!.values, bb = atHttpRank(b, rank).trace!.values;
      lines.push(`| p${rank * 100} | ${delta(aa.http, bb.http)} | ${delta(aa.component_sum, bb.component_sum)} | ${delta(aa.unexplained, bb.unexplained)} | ${delta(aa.sync_check_and_nonpage_sql, bb.sync_check_and_nonpage_sql)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
