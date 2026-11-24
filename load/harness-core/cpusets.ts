// Fixed, non-overlapping CPU sets for the PostgreSQL server and the load clients (#796 item 3).
// Processes are pinned with taskset, which the postgres image ships (util-linux); children inherit it.

export type CpuSets = { server: number[]; client: number[] };

export function parseCpuList(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`invalid CPU list: ${text}`);
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (to < from) throw new Error(`invalid CPU range: ${part}`);
    for (let c = from; c <= to; c++) out.add(c);
  }
  return [...out].sort((a, b) => a - b);
}

// "server=0,2,4;client=1,3,5". Both sets are required, disjoint and within the host's CPUs.
export function parseCpuSets(text: string, logicalCpus: number): CpuSets {
  const fields = Object.fromEntries(text.split(';').map(p => p.split('=').map(s => s.trim())));
  const keys = Object.keys(fields).sort().join(',');
  if (keys !== 'client,server') throw new Error(`--cpu-sets needs exactly server=... and client=..., got: ${text}`);
  const sets = { server: parseCpuList(fields.server), client: parseCpuList(fields.client) };
  const overlap = sets.server.filter(c => sets.client.includes(c));
  if (overlap.length > 0) throw new Error(`CPU sets overlap on ${overlap.join(',')}`);
  const outside = [...sets.server, ...sets.client].filter(c => c >= logicalCpus);
  if (outside.length > 0) throw new Error(`CPU ${outside.join(',')} does not exist on this host (${logicalCpus} CPUs)`);
  return sets;
}

export const cpuList = (cpus: number[]) => cpus.join(',');
export const pinned = (cpus: number[] | undefined, argv: string[]) => cpus ? ['taskset', '-c', cpuList(cpus), ...argv] : argv;

// `Cpus_allowed_list` in /proc/<pid>/status, expanded, for checking that a pin took effect.
export function allowedCpus(status: string): number[] {
  const m = /^Cpus_allowed_list:\s*(.+)$/m.exec(status);
  if (!m) throw new Error('Cpus_allowed_list not found');
  return parseCpuList(m[1]);
}
