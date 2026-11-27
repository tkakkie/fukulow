// Converts cumulative PostgreSQL counters to measured-window statistics.
const statementKeys = [
  'calls', 'execMs', 'rows', 'sharedBlksHit', 'sharedBlksRead', 'sharedBlksDirtied', 'sharedBlksWritten', 'walRecords', 'walFpi', 'walBytes',
] as const;
const functionKeys = ['calls', 'totalMs', 'selfMs'] as const;
export const walKeys = ['records', 'recordBytes', 'fpiCount', 'fpiBytes', 'walBytes'] as const;

export type Metrics<K extends string> = Record<K, number>;
type StatementKey = typeof statementKeys[number];
type FunctionKey = typeof functionKeys[number];
export type WalKey = typeof walKeys[number];
type Statement = { queryId: string; topLevel: boolean; query: string | null; statsSince: string };
type TrackedFunction = { oid: string; name: string };
type Sample<I, K extends string> = { identity: I; counters: Metrics<K> };
type Delta<I, K extends string> = I & { total: Metrics<K>; perSend: Metrics<K> };

export type Snapshot = {
  statements: Sample<Statement, StatementKey>[];
  functions: Sample<TrackedFunction, FunctionKey>[];
  deallocations: number;
  statsReset: string | null;
};

export type WalRecordType = { resourceManager: string; recordType: string };
export type WalInspection =
  | { complete: true; records: Delta<WalRecordType, WalKey>[] }
  | { complete: false; reason: string };

export const attributionMetadata = {
  status: 'DIAGNOSTIC / NOT EVALUATED',
  note: 'Instrumentation lowers tps. Totals are not comparable to #796 or to the stop rule. Use only the split between arms.',
};

export function mapMetrics<K extends string>(keys: readonly K[], map: (key: K) => number): Metrics<K> {
  return Object.fromEntries(keys.map(key => [key, map(key)])) as Metrics<K>;
}

function validateSendCount(sends: number) {
  if (!Number.isSafeInteger(sends) || sends <= 0) throw new Error(`Invalid committed send count: ${sends}`);
}

function normalize<K extends string>(keys: readonly K[], total: Metrics<K>, sends: number) {
  return mapMetrics(keys, key => total[key] / sends);
}

function diff<I, K extends string>(
  before: Sample<I, K>[], after: Sample<I, K>[], keys: readonly K[], sends: number,
  identify: (sample: I) => string, issues: string[], generation?: (sample: I) => string,
): Delta<I, K>[] {
  const previous = new Map(before.map(row => [identify(row.identity), row]));
  const rows: Delta<I, K>[] = [];
  for (const row of after) {
    const id = identify(row.identity);
    let earlier = previous.get(id);
    previous.delete(id);
    if (earlier && generation && generation(earlier.identity) !== generation(row.identity)) {
      issues.push(`Counters were recreated for ${id}. Only the new generation was counted.`);
      earlier = undefined;
    }
    const total = mapMetrics(keys, key => row.counters[key] - (earlier?.counters[key] ?? 0));
    if (Object.values<number>(total).some(value => !Number.isFinite(value) || value < 0)) {
      issues.push(`Counters regressed or were invalid for ${id}.`);
      continue;
    }
    if (Object.values<number>(total).some(value => value !== 0)) {
      rows.push({ ...row.identity, total, perSend: normalize(keys, total, sends) });
    }
  }
  for (const id of previous.keys()) issues.push(`Counters disappeared for ${id}.`);
  return rows;
}

export function diffSnapshots(before: Snapshot, after: Snapshot, sends: number) {
  validateSendCount(sends);
  const issues: string[] = [];
  if (before.statsReset !== after.statsReset || before.deallocations !== after.deallocations) {
    issues.push('pg_stat_statements reported a reset or eviction during the window.');
  }
  const statements = diff<Statement, StatementKey>(before.statements, after.statements, statementKeys, sends,
    s => `query ${s.queryId} (top-level=${s.topLevel})`, issues, s => s.statsSince)
    .map(s => ({ ...s, meanExecMs: s.total.calls > 0 ? s.total.execMs / s.total.calls : null }));
  if (statements.some(s => s.query === null)) issues.push('pg_stat_statements did not retain query text for every measured entry.');
  const functions = diff<TrackedFunction, FunctionKey>(before.functions, after.functions, functionKeys, sends,
    f => `function ${f.oid} (${f.name})`, issues);
  return { issues, statements, functions };
}

export function parseWalInspection(output: string, sends: number): WalInspection {
  validateSendCount(sends);
  const rows = JSON.parse(output) as (Omit<Metrics<WalKey>, 'walBytes'> & {
    label: string; countedFpiBytes: number | null;
  })[];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('WAL inspection returned no records');
  const records = rows.map(({ label, records, recordBytes, fpiCount, fpiBytes, countedFpiBytes }) => {
    const [resourceManager, recordType, extra] = label.split('/');
    if (!resourceManager || !recordType || extra !== undefined ||
        ![records, recordBytes, fpiCount, fpiBytes].every(v => Number.isSafeInteger(v) && v >= 0) ||
        records === 0 || fpiBytes !== (countedFpiBytes ?? 0)) {
      throw new Error(`Invalid WAL counts or inconsistent FPI bytes for ${label}`);
    }
    const total = { records, recordBytes, fpiCount, fpiBytes, walBytes: recordBytes + fpiBytes };
    return { resourceManager, recordType, total, perSend: normalize(walKeys, total, sends) };
  });
  return { complete: true, records };
}

export function walWindowBytes(beforeLsn: string, afterLsn: string) {
  const bytes = (lsn: string) => {
    const [high, low] = lsn.split('/');
    return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
  };
  return Number(bytes(afterLsn) - bytes(beforeLsn));
}

export type AttributionBlock = {
  order: number;
  arm: 'current' | 'final' | 'final+f1';
  transactions: number;
  latencyMs: number;
  walBytesPerSend: number;
  beforeLsn: string;
  afterLsn: string;
  stats: ReturnType<typeof diffSnapshots>;
  wal: WalInspection;
};

export { statementKeys, functionKeys };
