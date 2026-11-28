import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { save } from '../bench.ts';
import { fullySampled } from '../d3r/acceptance.ts';
import { explainPage, prepare } from '../d3r/engine.ts';
import { productionPath } from '../d3r/path.ts';
import { recordedWarmup } from '../d3r/run.ts';
import { withSession } from '../d3r/session.ts';
import { timeQuery } from '../d3r/timing.ts';
import { base, db, full, queries } from './design.ts';
import { heap, lookup, maintenance, parseSample, sampleSql } from './sampler.ts';
import type { SnapshotId } from './sequence.ts';

const physicalSql = `SELECT jsonb_build_object(
  'heap', (SELECT to_jsonb(t) FROM pgstattuple('${heap}') t),
  'lookup', (SELECT to_jsonb(i) FROM pgstatindex('${lookup}') i),
  'maintenance', (SELECT to_jsonb(i) FROM pgstatindex('${maintenance}') i),
  'visibility', (SELECT to_jsonb(v) || jsonb_build_object('heap_pages',
    pg_relation_size('${heap}') / current_setting('block_size')::bigint)
    FROM pg_visibility_map_summary('${heap}') v));`;

type Physical = {
  heap: {dead_tuple_percent: number; free_percent: number};
  lookup: {avg_leaf_density: number; leaf_fragmentation: number};
  maintenance: {avg_leaf_density: number; leaf_fragmentation: number};
  visibility: {all_visible: number; all_frozen: number; heap_pages: number};
};
type PlanNode = {'Node Type': string; 'Index Name'?: string; 'Heap Fetches'?: number; Plans?: PlanNode[]};
const percentage = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;

export function physical(raw: string) {
  const result: Physical = JSON.parse(raw);
  const {heap, lookup, maintenance, visibility} = result;
  assert.ok([heap?.dead_tuple_percent, heap?.free_percent, lookup?.avg_leaf_density, lookup?.leaf_fragmentation,
    maintenance?.avg_leaf_density, maintenance?.leaf_fragmentation].every(percentage), 'Missing tuple or index statistics');
  assert.ok(visibility && [visibility.all_visible, visibility.all_frozen, visibility.heap_pages].every(Number.isSafeInteger) &&
    visibility.all_frozen >= 0 && visibility.all_visible >= visibility.all_frozen &&
    visibility.heap_pages >= visibility.all_visible, 'Missing visibility evidence');
  return {...result, allVisibleShare: visibility.heap_pages ? visibility.all_visible / visibility.heap_pages : null};
}

export function heapFetches(node: PlanNode): number[] {
  assert.ok(typeof node?.['Node Type'] === 'string', 'Missing generic plan node');
  const children = (node.Plans ?? []).flatMap(heapFetches);
  if (node['Node Type'] !== 'Index Only Scan' || node['Index Name'] !== 'message_search_terms_lookup') return children;
  const fetches = node['Heap Fetches'];
  assert.ok(typeof fetches === 'number' && Number.isSafeInteger(fetches) && fetches >= 0, 'Missing heap fetch evidence');
  return [fetches, ...children];
}

async function search(container: string, dir: string, smoke: boolean) {
  const {page} = productionPath();
  // The 1M round warms one first page of each accepted query before collecting latency.
  const warmup = await recordedWarmup(`${dir}/warmup.json`, page, queries, base.performance.warmupSweeps,
    work => withSession(container, db, true, work));
  assert.equal(warmup.length, 0, 'Search warm-up did not return a valid page');
  if (smoke) return {untimedQueries: queries.map(([query]) => query)};
  const latencies = [];
  for (const [query, raw] of queries) {
    const result = await timeQuery(container, db, page, query, raw, false, `${dir}/${query}`, full.transactions, full.clients);
    assert.ok(fullySampled(result), `Incomplete search samples for ${query}`);
    latencies.push(result);
  }
  const plans = await withSession(container, db, true, async app => {
    await app(prepare(page));
    const results = [];
    for (const [query, raw] of queries) {
      const plan = await explainPage(app, raw);
      save(`${dir}/${query}-plan.json`, plan.explain);
      results.push({query, lookupExecuted: plan.searchIndex, lookupHeapFetches: heapFetches(plan.explain[0].Plan)});
    }
    return results;
  });
  return {latencies, plans, worstP95Ms: Math.max(...latencies.map(result => 'p95' in result ? result.p95 : NaN))};
}

export async function capture(container: string, destination: string, id: SnapshotId, smoke: boolean) {
  const dir = `${destination}/${id.replaceAll(' ', '-').toLowerCase()}`;
  mkdirSync(dir);
  const result = await withSession(container, db, false, async owner => ({
    id, sample: parseSample(await owner(sampleSql)), physical: physical(await owner(physicalSql)),
  }));
  save(`${dir}/storage.json`, result);
  const evidence = {...result, search: await search(container, dir, smoke)};
  save(`${dir}/snapshot.json`, evidence);
  return evidence;
}
export type Snapshot = Awaited<ReturnType<typeof capture>>;
