import { attributionMetadata, functionKeys, mapMetrics, statementKeys, walKeys, type AttributionBlock, type Metrics } from './attribution.ts';

type Comparison = { current: number; final: number; delta: number };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const compare = (current: number, final: number): Comparison => ({ current, final, delta: final - current });

function medians<K extends string>(
  blocks: AttributionBlock[], keys: readonly K[], read: (block: AttributionBlock) => { label: string; perSend: Metrics<K> }[],
) {
  const groups = blocks.map(block => {
    const items = new Map<string, Metrics<K>>();
    for (const { label, perSend } of read(block)) {
      const previous = items.get(label);
      items.set(label, mapMetrics(keys, key => (previous?.[key] ?? 0) + perSend[key]));
    }
    return { arm: block.arm, items };
  });
  const current = groups.filter(b => b.arm === 'current');
  const final = groups.filter(b => b.arm === 'final');
  const labels = new Set(groups.flatMap(b => [...b.items.keys()]));
  const armMedian = (arm: typeof groups, label: string) => mapMetrics(keys, key => median(arm.map(b => b.items.get(label)?.[key] ?? 0)));
  return [...labels].sort().map(label => {
    const c = armMedian(current, label), f = armMedian(final, label);
    return { label, current: c, final: f, delta: mapMetrics(keys, key => f[key] - c[key]) };
  });
}

type Ranked = Comparison & { label: string; share: number | null };
function rank<K extends string>(
  rows: { label: string; current: Metrics<K>; final: Metrics<K> }[],
  key: K, total: Comparison, additive: boolean,
) {
  const withShare = (row: Comparison, label: string): Ranked =>
    ({ label, ...row, share: total.delta === 0 ? null : row.delta / total.delta });
  const items = rows.map(row => withShare(compare(row.current[key], row.final[key]), row.label))
    .sort((a, b) => b.delta - a.delta || a.label.localeCompare(b.label));
  const unattributed = additive ? withShare(compare(
    total.current - items.reduce((sum, row) => sum + row.current, 0),
    total.final - items.reduce((sum, row) => sum + row.final, 0),
  ), 'Unattributed') : null;
  return { items, unattributed };
}

export function summarizeAttribution(blocks: AttributionBlock[], plannedBlocks: number, runComplete = true) {
  const current = blocks.filter(b => b.arm === 'current');
  const final = blocks.filter(b => b.arm === 'final');
  const coverage = blocks.map(b => ({ order: b.order, arm: b.arm, committedSends: b.transactions,
    statsIssues: b.stats.issues, walIssue: b.wal.complete ? null : b.wal.reason }));
  const complete = runComplete && blocks.length === plannedBlocks && coverage.every(b => b.walIssue === null && b.statsIssues.length === 0);
  const status = { ...attributionMetadata, complete, runComplete, plannedBlocks, coverage };
  if (current.length === 0 || final.length === 0) {
    return { ...status, comparison: null };
  }
  const acrossArms = (value: (b: AttributionBlock) => number) => compare(median(current.map(value)), median(final.map(value)));
  const timeMsPerSend = acrossArms(b => b.latencyMs);
  const walBytesPerSend = acrossArms(b => b.walBytesPerSend);
  const statements = (topLevel: boolean) => medians(blocks, statementKeys, b => b.stats.statements
    .filter(s => s.topLevel === topLevel)
    .map(s => ({ label: s.query?.trim() || `[queryid ${s.queryId}, text unavailable]`, perSend: s.perSend })));
  const topLevel = statements(true);
  const nested = statements(false);
  const functions = medians(blocks, functionKeys, b => b.stats.functions.map(f => ({ label: f.name, perSend: f.perSend })));
  const walTypes = blocks.every(b => b.wal.complete) ? medians(blocks, walKeys, b => b.wal.complete
    ? b.wal.records.map(w => ({ label: `${w.resourceManager}/${w.recordType}`, perSend: w.perSend })) : []) : null;
  return {
    ...status,
    comparison: {
      timeMsPerSend, walBytesPerSend,
      medians: { topLevel, nested, functions, walTypes },
      rankings: {
        functionSelfTime: rank(functions, 'selfMs', timeMsPerSend, true),
        topLevelStatementTime: rank(topLevel, 'execMs', timeMsPerSend, true),
        nestedStatementTime: rank(nested, 'execMs', timeMsPerSend, false),
        walByRecordType: walTypes && rank(walTypes, 'walBytes', walBytesPerSend, true),
        topLevelStatementWal: rank(topLevel, 'walBytes', walBytesPerSend, true),
        nestedStatementWal: rank(nested, 'walBytes', walBytesPerSend, false),
      },
    },
  };
}

export function attributionMarkdown(summary: ReturnType<typeof summarizeAttribution>) {
  const { coverage, plannedBlocks, complete, comparison } = summary;
  const lines = [
    `# #519 A3 send attribution — ${summary.status}`, '', summary.note, '',
    `Captured ${coverage.length}/${plannedBlocks} measured blocks. Attribution is ${complete ? 'complete' : 'incomplete'}.`, '',
    ...(summary.runComplete ? [] : ['The harness reported a failure. See `status.json` and the run log.', '']),
    ...coverage.flatMap(b => [...b.statsIssues, ...(b.walIssue === null ? [] : [`WAL inspection: ${b.walIssue}`])]
      .map(issue => `- Block ${b.order}, ${b.arm}: ${issue.replace(/\s+/g, ' ')}`)),
  ];
  if (!comparison) return [...lines, '', 'An arm has no measured blocks.', ''].join('\n');

  const fmt = (n: number) => n.toFixed(6);
  const { timeMsPerSend, walBytesPerSend, rankings } = comparison;
  const tableRow = (label: string, x: Comparison, share = '—') =>
    `| ${label} | ${fmt(x.current)} | ${fmt(x.final)} | ${fmt(x.delta)} | ${share} |`;
  const header = ['| Item | Current | Final | Final − current | Share of total delta |', '|---|---:|---:|---:|---:|'];
  const walBreakdown = new Map(comparison.medians.walTypes?.map(w => [w.label, w.delta]));
  const table = (title: string, ranking: typeof rankings.walByRecordType, includeWalBreakdown = false) => {
    lines.push('', `## ${title}`, '');
    if (!ranking) {
      lines.push('WAL record-type medians and remainder are unavailable because a measured window could not be inspected.');
      return;
    }
    lines.push(...(includeWalBreakdown ? [
      header[0] + ' Δ record bytes/send | Δ FPI bytes/send | Δ FPI count/send |', header[1] + '---:|---:|---:|',
    ] : header));
    for (const item of [...ranking.items, ...(ranking.unattributed ? [ranking.unattributed] : [])]) {
      const label = item.label.replace(/\s+/g, ' ').replace(/[<>&|`\\]/g, c => `&#${c.charCodeAt(0)};`);
      const row = tableRow(label, item, item.share === null ? '—' : `${(100 * item.share).toFixed(2)}%`);
      const wal = walBreakdown.get(item.label);
      lines.push(!includeWalBreakdown ? row : row + (wal ? ` ${fmt(wal.recordBytes)} | ${fmt(wal.fpiBytes)} | ${fmt(wal.fpiCount)} |` : ' — | — | — |'));
    }
  };

  lines.push('', ...header, tableRow('Mean pgbench transaction latency (ms/send)', timeMsPerSend),
    tableRow('WAL insert-LSN bytes/send', walBytesPerSend), '',
    'Each arm uses medians of block values per committed pgbench transaction. Missing items in observed blocks count as zero.',
    'Statements match across clones by query text and top-level status. Functions match by schema, name and arguments.',
    'Top-level statements, nested statements and functions show overlapping work. Function self time excludes time in other tracked functions.',
    'Nested statements can include work in deeper statements, so they have no additive remainder.',
    'Each unattributed remainder subtracts the sum of that view’s item medians from the arm total median.',
    'Time remainders can include planning, commit and client waits. WAL remainders can include headers, padding and segment gaps.',
    'Independent medians can also affect the remainders. WAL record types cover the whole cluster.');
  table('Function self time (ms/send)', rankings.functionSelfTime);
  table('Nested statement execution time (ms/send)', rankings.nestedStatementTime);
  table('Top-level statement execution time (ms/send)', rankings.topLevelStatementTime);
  table('WAL by resource manager and record type (bytes/send)', rankings.walByRecordType, true);
  table('Nested statement WAL (bytes/send)', rankings.nestedStatementWal);
  table('Top-level statement WAL (bytes/send)', rankings.topLevelStatementWal);
  return [...lines, ''].join('\n');
}
