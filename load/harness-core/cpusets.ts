// Fixed, non-overlapping CPU sets for the PostgreSQL server and the load clients (#796 item 3).
// Processes are pinned with taskset, which the postgres image ships (util-linux); children inherit it.

export type CpuSets = { server: number[]; client: number[]; housekeeping?: number[] };

// Endpoints are bounded before expansion, so an oversized range cannot loop or allocate.
export function parseCpuList(text: string, limit = 65_536): number[] {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`invalid CPU list: ${text}`);
    const [from, to] = [Number(m[1]), Number(m[2] ?? m[1])];
    if (to < from) throw new Error(`invalid CPU range: ${part}`);
    if (to >= limit) throw new Error(`CPU ${to} does not exist on this host (${limit} CPUs)`);
    for (let c = from; c <= to; c++) out.add(c);
  }
  return [...out].sort((a, b) => a - b);
}

// Server and client are required. All supplied sets are disjoint and within the host's CPUs.
export function parseCpuSets(text: string, logicalCpus: number): CpuSets {
  const fields = new Map<string, number[]>();
  for (const field of text.split(';')) {
    const match = /^\s*(server|client|housekeeping)\s*=([^=]+)$/.exec(field);
    if (!match || fields.has(match[1])) throw new Error(`invalid or repeated --cpu-sets field: ${field}`);
    fields.set(match[1], parseCpuList(match[2], logicalCpus));
  }
  const server = fields.get('server'), client = fields.get('client'), housekeeping = fields.get('housekeeping');
  if (!server || !client) throw new Error('--cpu-sets needs exactly server=... and client=..., with optional housekeeping=...');
  const all = [...server, ...client, ...(housekeeping ?? [])];
  const seen = new Set<number>();
  for (const cpu of all) {
    if (seen.has(cpu)) throw new Error(`CPU sets overlap on ${cpu}`);
    seen.add(cpu);
  }
  return { server, client, ...(housekeeping ? { housekeeping } : {}) };
}

export const cpuList = (cpus: number[]) => cpus.join(',');
export const pinned = (cpus: number[] | undefined, argv: string[]) => cpus ? ['taskset', '-c', cpuList(cpus), ...argv] : argv;

// `Cpus_allowed_list` in /proc/<pid>/status, expanded, for checking that a pin took effect.
export function allowedCpus(status: string): number[] {
  const m = /^Cpus_allowed_list:\s*(.+)$/m.exec(status);
  if (!m) throw new Error('Cpus_allowed_list not found');
  return parseCpuList(m[1]);
}
