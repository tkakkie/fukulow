import { percentile } from '../../search-engines/bench.ts';

type Node = {
  'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string;
  'Actual Loops': number; 'Actual Rows': number; 'Rows Removed by Filter'?: number;
  'Index Cond'?: string; 'Recheck Cond'?: string; Filter?: string;
  'Sort Method'?: string; Plans?: Node[];
};
export type Explain = [{Plan: Node; 'Execution Time': number}];
const flatten = (node: Node): Node[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
export function planFacts(explain: Explain) {
  const nodes = flatten(explain[0].Plan);
  return {
    executionMs: explain[0]['Execution Time'],
    searchTermsExactKey: nodes.some(n => n['Index Name'] === 'search_terms_exact'
      && n['Actual Loops'] > 0 && /scope_term.*=.*v\.id/.test(n['Index Cond'] ?? '')),
    searchTermsSequential: nodes.some(n => n['Relation Name'] === 'search_terms' && n['Node Type'] === 'Seq Scan'),
    orderedChannelIndexScan: nodes.some(n => n['Node Type'] === 'Index Scan'
      && n['Index Name'] === 'search_channel_recent' && n['Actual Loops'] > 0),
    b1IndexUsed: nodes.some(n => n['Index Name'] === 'search_body' && n['Actual Loops'] > 0),
    scansAndSorts: nodes.filter(n => n['Relation Name'] || n['Index Name'] || n['Sort Method']).map(n => ({
      type:n['Node Type'], relation:n['Relation Name'], index:n['Index Name'],
      loops:n['Actual Loops'], rowsPerLoop:n['Actual Rows'], filterRemovedPerLoop:n['Rows Removed by Filter'],
      indexCondition:n['Index Cond'], recheck:n['Recheck Cond'], filter:n.Filter,
      sort:n['Sort Method'],
      sortInputRowsPerLoop:n['Sort Method'] ? n.Plans?.[0]?.['Actual Rows'] : undefined,
    })),
  };
}

export function summarize(samples: number[]) {
  if (!samples.length || !samples.every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid samples');
  return {n:samples.length, p50:percentile(samples,.50)!, p95:percentile(samples,.95)!};
}
export function ratios(few: ReturnType<typeof summarize>, many: ReturnType<typeof summarize>) {
  return {
    p50: few.p50 ? many.p50 / few.p50 : null,
    p95: few.p95 ? many.p95 / few.p95 : null,
  };
}

export function scaledBytes(bytes: number, messages: number) {
  return {bytes, per10k:Math.round(bytes * 10000 / messages), linearAt1M:Math.round(bytes * 1000000 / messages)};
}
