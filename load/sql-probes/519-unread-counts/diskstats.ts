export type Device = { id: string; name: string };
const fields = {
  readsCompleted: 0, writesCompleted: 4, sectorsWritten: 6, msWriting: 7, ioTicks: 9, weightedMsInQueue: 10,
} as const;
export type DiskCounters = Record<keyof typeof fields, number> & { flushesCompleted: number | null; msFlushing: number | null };
export type DiskRow = Device & DiskCounters;

export function parseDiskstats(text: string, ids: string[]): DiskRow[] {
  const rows = new Map<string, DiskRow>();
  for (const line of text.trim().split('\n')) {
    const [major, minor, name, ...values] = line.trim().split(/\s+/);
    const id = `${major}:${minor}`;
    if (!ids.includes(id)) continue;
    const counters = values.map(Number);
    if (rows.has(id) || !name || (![11, 15].includes(values.length) && values.length < 17) ||
        values.some((value, i) => !/^\d+$/.test(value) || !Number.isSafeInteger(counters[i]))) {
      throw new Error(`invalid /proc/diskstats row for ${id}`);
    }
    const base = Object.fromEntries(Object.entries(fields).map(([key, i]) => [key, counters[i]])) as Record<keyof typeof fields, number>;
    rows.set(id, { id, name, ...base, flushesCompleted: counters[15] ?? null, msFlushing: counters[16] ?? null });
  }
  return ids.map(id => {
    const row = rows.get(id);
    if (!row) throw new Error(`device ${id} missing from /proc/diskstats`);
    return row;
  });
}

export function diskDelta(before: DiskRow, after: DiskRow): DiskRow {
  if (before.id !== after.id || before.name !== after.name) throw new Error(`diskstats identity changed for ${before.id} (${before.name})`);
  const { id, name, ...counters } = after;
  const delta = (field: keyof DiskCounters) => {
    const start = before[field], end = after[field];
    if (start === null && end === null) return null;
    if (start === null || end === null || end < start) throw new Error(`diskstats ${name} ${field} reset or changed layout`);
    return end - start;
  };
  return {
    id, name, ...Object.fromEntries(Object.keys(counters).map(key => [key, delta(key as keyof DiskCounters)])) as DiskCounters,
  };
}
