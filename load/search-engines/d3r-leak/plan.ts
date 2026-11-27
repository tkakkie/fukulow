import assert from 'node:assert/strict';

type Node = {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Heap Fetches'?: number;
  Plans?: Node[];
};

const lookup = 'message_search_terms_lookup';

export function planFacts([{Plan: root}]: [{Plan: Node}]) {
  let heapFetches = 0;
  function shape(node: Node): unknown {
    assert.equal(typeof node['Node Type'], 'string');
    const index = node['Index Name'] ?? null;
    let lookupRows: number | null = null;
    if (index === lookup) {
      const loops = node['Actual Loops'];
      assert.ok(Number.isFinite(node['Actual Rows']) && Number.isSafeInteger(loops), 'Lookup plan lacks actual row counts');
      // EXPLAIN averages row counters over executions of the lookup node.
      lookupRows = Math.round(node['Actual Rows'] * loops) +
        Math.round((node['Rows Removed by Filter'] ?? 0) * loops) +
        Math.round((node['Rows Removed by Index Recheck'] ?? 0) * loops);
      heapFetches += node['Heap Fetches'] ?? 0;
    }
    return [node['Node Type'], index, lookupRows, (node.Plans ?? []).map(shape)];
  }
  const structure = shape(root);
  // Root buffer counters already include their descendants.
  return {shape: JSON.stringify(structure), heapFetches,
    sharedHit: root['Shared Hit Blocks'] ?? 0, sharedRead: root['Shared Read Blocks'] ?? 0};
}
