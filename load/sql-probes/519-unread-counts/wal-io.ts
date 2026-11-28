// PostgreSQL 18 counts. The reset timestamps are used to detect invalid deltas.
const ioFields = ['reads', 'read_bytes', 'writes', 'write_bytes', 'writebacks', 'extends', 'extend_bytes',
  'hits', 'evictions', 'reuses', 'fsyncs'] as const;
const walFields = ['wal_records', 'wal_fpi', 'wal_bytes', 'wal_buffers_full'] as const;

export const walIoQuery = `
  SELECT json_build_object(
    'atMs', extract(epoch FROM clock_timestamp()) * 1000,
    'io', (SELECT json_agg(i ORDER BY backend_type, context) FROM
           (SELECT backend_type, object, context, ${ioFields.join(', ')}, stats_reset FROM pg_stat_io WHERE object = 'wal') i),
    'wal', (SELECT row_to_json(w) FROM (SELECT ${walFields.join(', ')}, stats_reset FROM pg_stat_wal) w));
`;

type WalIoRow = Record<typeof ioFields[number], number | null> & {
  backend_type: string; object: 'wal'; context: string; stats_reset: string | null;
};
type WalCounts = Record<typeof walFields[number], number>;
export type WalIoSnapshot = { atMs: number; io: WalIoRow[]; wal: WalCounts & { stats_reset: string | null } };

export function parseWalIo(output: string): WalIoSnapshot {
  const snapshot: WalIoSnapshot = JSON.parse(output);
  if (!Number.isFinite(snapshot?.atMs) || !Array.isArray(snapshot.io) || snapshot.io.length === 0 || !snapshot.wal) {
    throw new Error('invalid WAL I/O snapshot');
  }
  return snapshot;
}

function countsDelta<T extends string>(fields: readonly T[], before: Record<T, number | null>, after: Record<T, number | null>) {
  return Object.fromEntries(fields.map(key => {
    const a = before[key], b = after[key];
    if (a === null && b === null) return [key, null];
    if (a === null || b === null || !Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a) {
      throw new Error(`${key} reset or changed layout`);
    }
    return [key, b - a];
  })) as Record<T, number | null>;
}

export function walIoDelta(before: WalIoSnapshot, after: WalIoSnapshot) {
  if (before.wal.stats_reset !== after.wal.stats_reset) throw new Error('pg_stat_wal reset');
  const wal = countsDelta(walFields, before.wal, after.wal);
  const key = (row: WalIoRow) => JSON.stringify([row.backend_type, row.context]);
  const previous = new Map(before.io.map(row => [key(row), row]));
  const backend = new Map<string, Partial<Record<typeof ioFields[number], number>>>();
  for (const row of after.io) {
    const id = key(row), prior = previous.get(id);
    if (!prior || row.stats_reset !== prior.stats_reset) throw new Error(`pg_stat_io WAL row changed or reset for ${id}`);
    previous.delete(id);
    const delta = countsDelta(ioFields, prior, row);
    const counts = backend.get(row.backend_type) ?? {};
    for (const field of ioFields) {
      const value = delta[field];
      if (value !== null) counts[field] = (counts[field] ?? 0) + value;
    }
    backend.set(row.backend_type, counts);
  }
  if (previous.size) throw new Error('pg_stat_io WAL rows disappeared');
  return { wal, backend: Object.fromEntries(backend) };
}
