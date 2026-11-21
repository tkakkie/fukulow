import { partC, replayPosition } from '../../slice5/config.ts';
import { execute, pgbenchExecute, prepare, type Bindings, type Statement } from './sql.ts';

export const modes = ['force_custom_plan', 'force_generic_plan', 'auto'] as const;
export type Cell = { name: string; size: number; depth: string };
export const preparedState = `SELECT COALESCE(json_agg(s ORDER BY s.name), '[]') FROM
  (SELECT name, parameter_types, generic_plans, custom_plans FROM pg_prepared_statements) s;`;

export function position(cell: Cell, i: number) {
  const index = i + partC.warmups * partC.readers;
  return replayPosition(cell.size, partC.recentWindow, partC.limit, cell.depth,
    index % partC.readers, Math.floor(index / partC.readers));
}

export function pgbenchScript(sequence: Statement[], cell: Cell, first: number) {
  const recent = cell.depth === 'recent';
  // Integer arithmetic follows config.ts's replayPosition for the fixture scale.
  return [
    '\\if :client_sample = 0',
    ...sequence.filter(stmt => stmt.parameters).map(stmt => prepare(stmt).replace(/\s*\n\s*/g, ' ')),
    '\\endif',
    '\\set i ' + (first + partC.warmups * partC.readers) + ' + :client_sample',
    '\\set client_sample :client_sample + 1',
    `\\set spin (((:i % ${partC.readers}) * 7919 + (:i / ${partC.readers}) * 104729) % 4294967296)`,
    `\\set after ${recent ? cell.size - partC.recentWindow : 0} + (:spin % ${recent ? partC.recentWindow - partC.limit : Math.floor(cell.size / 2)})`,
    ...sequence.map(pgbenchExecute),
  ].join('\n') + '\n';
}

export function psqlTiming(sequence: Statement[], cell: Cell, bindings: Bindings, first: number, count: number) {
  return [
    ...sequence.map(prepare),
    '\\o /dev/null', '\\timing on',
    ...Array.from({ length: count }, (_, i) => [
      `\\echo @sample-${first + i}`,
      ...sequence.map(stmt => execute(stmt, { ...bindings, after: position(cell, first + i) }) + ';'),
    ].join('\n')),
    '\\timing off', '\\o', '\\echo @prepared', preparedState,
  ].join('\n');
}

export function sections(output: string) {
  const out = new Map<string, string>();
  for (const section of output.split(/^@/m).slice(1)) {
    const end = section.indexOf('\n');
    const name = section.slice(0, end);
    if (end < 1 || out.has(name)) throw new Error('Invalid or duplicate output marker');
    out.set(name, section.slice(end + 1).trim());
  }
  return out;
}

export function timings(output: string, names: string[], first: number, count: number) {
  const blocks = sections(output);
  const samples = Array.from({ length: count }, (_, i) => {
    const index = first + i;
    const block = blocks.get('sample-' + index) ?? '';
    const times = block.split('\n').map(row => /^Time: (\d+(?:\.\d+)?) ms$/.exec(row)?.[1]);
    if (times.length !== names.length || times.some(t => t === undefined)) {
      throw new Error('Expected one psql timing per SQL statement');
    }
    const ms = times.map(Number);
    return { index, roundTripSumMs: ms.reduce((a, b) => a + b, 0),
      statementsMs: Object.fromEntries(names.map((name, n) => [name, ms[n]])) };
  });
  if (blocks.size !== count + 1 || !blocks.has('prepared')) throw new Error('Incomplete psql timings');
  return { samples, prepared: JSON.parse(blocks.get('prepared')!) as unknown };
}

export function pgbenchTimings(log: string, count: number) {
  const samples = log.trim().split('\n').map((line, i) => {
    const fields = line.trim().split(/\s+/);
    const [client, transaction, us, script] = fields;
    if (client !== '0' || Number(transaction) !== i + 1 || !/^\d+$/.test(us) || script !== '0') {
      throw new Error('Invalid pgbench transaction sample');
    }
    return Number(us) / 1000;
  });
  if (samples.length !== count) throw new Error('Incomplete pgbench timings');
  return samples;
}

export function quantiles(samples: number[]) {
  if (samples.length === 0 || samples.some(x => !Number.isFinite(x) || x < 0)) throw new Error('Invalid latency samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  return { n: sorted.length, p50: at(0.5), p95: at(0.95) };
}

type PlanNode = Record<string, unknown> & { 'Node Type': string; Plans?: PlanNode[] };
type Plan = { Plan: PlanNode; Planning?: Record<string, number>; Settings?: Record<string, string>;
  'Planning Time': number; 'Execution Time': number };

function buffers(node: Record<string, unknown> = {}) {
  return { sharedHit: node['Shared Hit Blocks'] ?? 0, sharedRead: node['Shared Read Blocks'] ?? 0,
    tempRead: node['Temp Read Blocks'] ?? 0, tempWritten: node['Temp Written Blocks'] ?? 0 };
}

export function describePlan(raw: Plan[], rows: number) {
  if (raw.length !== 1 || raw[0].Plan['Actual Rows'] !== rows || raw[0].Plan['Actual Loops'] !== 1) {
    throw new Error('Unexpected rows in EXPLAIN ANALYZE');
  }
  const plan = raw[0];
  const shape = (node: PlanNode): unknown => ({
    node: node['Node Type'], join: node['Join Type'], relation: node['Relation Name'],
    subplan: node['Subplan Name'], alias: node.Alias, index: node['Index Name'], indexCond: node['Index Cond'],
    actualRows: node['Actual Rows'], loops: node['Actual Loops'],
    ...buffers(node), children: node.Plans?.map(shape),
  });
  return { planningMs: plan['Planning Time'], executionMs: plan['Execution Time'], settings: plan.Settings,
    executionBuffers: buffers(plan.Plan), planningBuffers: buffers(plan.Planning), shape: shape(plan.Plan) };
}
