import { percentile } from '../../search-engines/bench.ts';

type Node = {
  'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string;
  'Actual Loops': number; 'Actual Rows': number; 'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number; 'Rows Removed by Join Filter'?: number;
  'Index Cond'?: string; 'Recheck Cond'?: string; Filter?: string;
  'Sort Method'?: string; 'Sort Key'?: string[]; 'Scan Direction'?: string;
  'Join Type'?: string; 'Join Filter'?: string; 'Hash Cond'?: string; 'Merge Cond'?: string;
  'Parent Relationship'?: string; 'Subplan Name'?: string; Strategy?: string; Plans?: Node[];
};
export type Explain = [{Plan: Node; 'Execution Time': number}];
const flatten = (node: Node): Node[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
function planShape(node: Node, predicates: boolean): unknown {
  return {
    type:node['Node Type'], relation:node['Relation Name'], index:node['Index Name'],
    direction:node['Scan Direction'], join:node['Join Type'], strategy:node.Strategy,
    parent:node['Parent Relationship'], subplan:node['Subplan Name'], sort:node['Sort Key'],
    ...(predicates && {indexCond:node['Index Cond'], recheck:node['Recheck Cond'], filter:node.Filter,
      joinCond:node['Join Filter'] ?? node['Hash Cond'] ?? node['Merge Cond']}),
    children:(node.Plans ?? []).map(child=>planShape(child,predicates)),
  };
}

export function planFacts(explain: Explain) {
  const nodes = flatten(explain[0].Plan);
  return {
    executionMs: explain[0]['Execution Time'],
    shape: planShape(explain[0].Plan,true),
    structure: planShape(explain[0].Plan,false),
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

function recencyWalk(explain: Explain) {
  const root = explain[0].Plan;
  const sort = root.Plans?.find(n => n['Node Type'] === 'Sort');
  const merge = sort?.Plans?.[0];
  const limit = merge?.Plans?.find(n => n['Node Type'] === 'Limit');
  const join = limit?.Plans?.[0];
  const [terms, messages] = join?.Plans ?? [];
  const key = terms?.['Index Cond'] ?? '';
  const ordered = root['Node Type'] === 'Limit' && merge?.['Node Type'] === 'Nested Loop'
    && join?.['Node Type'] === 'Nested Loop' && join.Plans?.length === 2
    && ['Index Only Scan','Index Scan'].includes(terms?.['Node Type'] ?? '')
    && terms?.['Index Name'] === 'search_terms_recent_key' && terms['Scan Direction'] === 'Forward'
    && /organization_id =/.test(key) && /channel_id = v.id/.test(key) && /term =/.test(key)
    && messages?.['Node Type'] === 'Index Scan' && messages['Index Name'] === 'messages_pkey'
    && (messages.Filter ?? '').includes('~~');
  return {ordered, merge, limit, terms, messages};
}

export function earlyStop(combined: Explain, byScope: Record<string, Explain>, visibleMatches: number) {
  const {ordered, merge, limit, terms} = recencyWalk(combined);
  const scopes = Object.entries(byScope).map(([scope, explain]) => {
    const walk = recencyWalk(explain);
    const candidates = walk.terms?.['Actual Rows'];
    const hits = walk.limit?.['Actual Rows'];
    // A single-scope plan gives exact term and Limit rows. The nested loop probes
    // the Message PK once per term, so their difference counts failed rechecks.
    const rejected = candidates === undefined || hits === undefined ? undefined : candidates - hits;
    const removed = walk.messages?.['Rows Removed by Filter'] ?? 0;
    const pass = walk.ordered && walk.terms?.['Actual Loops'] === 1 && walk.limit?.['Actual Loops'] === 1
      && walk.messages?.['Actual Loops'] === candidates && candidates !== undefined && hits !== undefined
      && rejected !== undefined && rejected >= 0 && candidates <= 20 + rejected
      && Math.abs(removed * candidates - rejected) <= 0.005001 * candidates;
    return {scope,candidates,hits,rejected,pass};
  });
  const mergeInput = merge?.['Actual Rows'];
  const fullReads = flatten(combined[0].Plan).flatMap(n => {
    const loops = n['Actual Loops'];
    const counts = [n['Actual Rows'], n['Rows Removed by Filter'], n['Rows Removed by Index Recheck'],
      n['Rows Removed by Join Filter']].filter(v => v !== undefined);
    const rowsUpperBound = loops * counts.reduce((sum, value) => sum + value + (loops > 1 ? 0.005 : 0), 0);
    return rowsUpperBound >= visibleMatches ? [{type:n['Node Type'],index:n['Index Name'],rowsUpperBound}] : [];
  });
  const scopeCount = scopes.length;
  const pass = ordered && scopeCount === 5 && limit?.['Actual Loops'] === scopeCount
    && terms?.['Actual Loops'] === scopeCount && merge?.['Actual Loops'] === 1
    && mergeInput !== undefined && mergeInput <= 5 * 20 && fullReads.length === 0
    && scopes.every(scope => scope.pass) && scopes.reduce((sum, scope) => sum + (scope.hits ?? 0),0) === mergeInput
    && Math.abs((terms?.['Actual Rows'] ?? 0) * scopeCount
      - scopes.reduce((sum, scope) => sum + (scope.candidates ?? 0),0)) <= 0.005001 * scopeCount;
  return {pass,ordered,mergeInput,visibleMatches,fullReads,scopes};
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

export function possibleLeak({p50,p95}: ReturnType<typeof ratios>) {
  return p50 !== null && p95 !== null
    && ((p50 >= 1.10 && p95 >= 1.10) || (p50 <= 0.91 && p95 <= 0.91));
}

export function scaledBytes(bytes: number, messages: number) {
  return {bytes, per10k:Math.round(bytes * 10000 / messages), linearAt1M:Math.round(bytes * 1000000 / messages)};
}
