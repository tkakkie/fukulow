const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const parseLine = (line: string) => object(JSON.parse(line));
const time = (value: unknown) => {
  if (typeof value !== 'string') return NaN;
  const fraction = /\.\d{3}(\d+)Z$/.exec(value)?.[1];
  return Date.parse(value) + (fraction ? Number(`0.${fraction}`) : 0);
};

export function cgroupSample(raw: string) {
  const value = (key: string) => Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(raw)?.[1]);
  const sample = { usage_usec: value('usage_usec'), nr_throttled: value('nr_throttled'),
    throttled_usec: value('throttled_usec'), memoryBytes: value('memory.current') };
  return Object.values(sample).every(integer) ? sample : null;
}

export function distributions(numbers: number[]) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.ceil(p * sorted.length) - 1] ?? null;
  return { count: sorted.length, p50: at(0.50), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? null };
}

const lanes = ['send', 'move'] as const;
const scenarios = [...lanes, 'reader', 'channels', 'topic0', 'topic1', 'topic2', 'topic3'] as const;
type Lane = typeof lanes[number];
type Scenario = typeof scenarios[number];
const phases = ['before_admission', 'channel_admission_wait', 'global_admission_wait', 'admitted_work', 'pool_acquire',
  'write_pool_acquire', 'send_access_sql', 'move_access_sql', 'channel_advisory_sql', 'commit_sql', 'move_chain_lookup', 'move_apply'] as const;
const reasons = ['global_queue_full', 'channel_queue_full', 'channel_admission_timeout', 'global_admission_timeout',
  'channel_admission_closed', 'global_admission_closed',
  'limiter_duplicate_waiters_cap', 'limiter_pending_cap', 'limiter_member_buckets_cap', 'shutdown', 'unclassified'] as const;
const member = <T extends string>(list: readonly T[], input: unknown): input is T => list.includes(input as T);

export function appEvidence(log: string) {
  const timing: { at: number; lane: Lane; phase: typeof phases[number]; us: number; interrupted: boolean }[] = [];
  const unavailable: { at: number; lane: Lane; reason: typeof reasons[number] }[] = [];
  for (const line of log.split('\n')) {
    if (!line.includes('move_diag_')) continue;
    const { timestamp, fields } = parseLine(line);
    const at = time(timestamp);
    const { event, lane, phase, us, interrupted, reason } = object(fields);
    if (!Number.isFinite(at) || !member(lanes, lane)) continue;
    if (event === 'move_diag_timing' && member(phases, phase) && nonnegative(us) && typeof interrupted === 'boolean')
      timing.push({ at, lane, phase, us, interrupted });
    if (event === 'move_diag_503' && member(reasons, reason)) unavailable.push({ at, lane, reason });
  }
  return {
    timing, unavailable,
    byLane: Object.fromEntries(lanes.map(lane => [lane, {
      reasons: Object.fromEntries(reasons.map(reason => [reason, unavailable.filter(sample => sample.lane === lane && sample.reason === reason).length])),
      phasesUs: Object.fromEntries(phases.flatMap(phase => {
        const points = timing.filter(sample => sample.lane === lane && sample.phase === phase);
        return points.length ? [[phase, { ...distributions(points.filter(sample => !sample.interrupted).map(sample => sample.us)),
          interrupted: points.filter(sample => sample.interrupted).length }]] : [];
      })),
    }])),
  };
}

export function k6CeilingWarnings(stderr: string) {
  return stderr.split('\n').flatMap(line => {
    const cap = /msg="Insufficient VUs, reached (\d+) active VUs and cannot initialize more"/.exec(line)?.[1];
    const scenario = /(?:^|\s)scenario=(\w+)(?:\s|$)/.exec(line)?.[1];
    const at = time(/(?:^|\s)time="([^"]+)"/.exec(line)?.[1]);
    return cap && member(scenarios, scenario) ? [{ scenario, maxVUs: Number(cap), at: Number.isFinite(at) ? at : null }] : [];
  });
}

export async function k6Evidence(lines: AsyncIterable<string>) {
  const vus = new Map<number, { at: number; active?: number; allocated?: number }>();
  const drops: { at: number; scenario: Scenario; count: number }[] = [];
  const busy: Record<Lane, { at: number; change: number }[]> = { send: [], move: [] };
  const completed503: Record<Scenario, number> = Object.fromEntries(scenarios.map(s => [s, 0])) as Record<Scenario, number>;
  for await (const line of lines) {
    if (!/"metric"\s*:\s*"(vus|vus_max|dropped_iterations|iteration_duration|http_reqs)"/.test(line)) continue;
    const { type, metric, data } = parseLine(line);
    if (type !== 'Point') continue;
    const { time: timestamp, value, tags } = object(data);
    const at = time(timestamp);
    const { scenario, status } = object(tags);
    if (!Number.isFinite(at) || !nonnegative(value)) continue;
    if ((metric === 'vus' || metric === 'vus_max') && integer(value)) {
      const sample = vus.get(at) ?? { at };
      sample[metric === 'vus' ? 'active' : 'allocated'] = value;
      vus.set(at, sample);
    } else if (metric === 'dropped_iterations' && member(scenarios, scenario) && integer(value)) {
      drops.push({ at, scenario, count: value });
    } else if (metric === 'iteration_duration' && member(lanes, scenario) && value > 0) {
      busy[scenario].push({ at: at - value, change: 1 }, { at, change: -1 });
    } else if (metric === 'http_reqs' && status === '503' && member(scenarios, scenario) && integer(value)) {
      completed503[scenario] += value;
    }
  }
  drops.sort((a, b) => a.at - b.at);
  const activeAtDrop = new Map<typeof drops[number], number>();
  for (const lane of lanes) {
    const changes = busy[lane].sort((a, b) => a.at - b.at);
    let cursor = 0, inFlight = 0;
    for (const drop of drops.filter(drop => drop.scenario === lane)) {
      while (cursor < changes.length && changes[cursor].at <= drop.at) inFlight += changes[cursor++].change;
      activeAtDrop.set(drop, inFlight);
    }
  }
  return { vus: [...vus.values()].sort((a, b) => a.at - b.at), completed503,
    drops: drops.map(drop => ({ ...drop, reconstructedWriteIterationsInFlight: activeAtDrop.get(drop) ?? null })) };
}

const queryId = (id: unknown): id is string => typeof id === 'string' && /^-?\d{1,20}$/.test(id);
export const dbSampleIntervalMs = 100;
export type DbSample = { at: number; waits: { queryId: string | null; type: string; event: string; count: number }[] };
export type Statement = { queryId: string; group: string; calls: number; execMs: number };
const waitTypes = ['Lock', 'LWLock', 'IO', 'BufferPin', 'Client', 'IPC', 'Timeout', 'Extension', 'Activity', 'running'] as const;
const queryGroups = ['channel_advisory_read', 'channel_advisory_write', 'move_chain_lookup', 'move_update', 'send_insert', 'row_lock_sql', 'other'] as const;

export function parseDbSample(line: string): DbSample {
  const { at, waits } = parseLine(line);
  if (!nonnegative(at) || !Array.isArray(waits)) throw new Error('Invalid PostgreSQL activity sample');
  const rows: DbSample['waits'] = waits.map(raw => {
    const { id, type, event, count } = object(raw);
    if (!(id === null || queryId(id)) || !integer(count)) throw new Error('Invalid PostgreSQL activity row');
    return { queryId: id, type: member(waitTypes, type) ? type : 'other',
      event: typeof event === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(event) ? event : 'other', count };
  });
  return { at, waits: rows };
}

export function parseStatements(raw: string): Statement[] {
  return raw ? raw.split('\n').map(line => {
    const { id, group, calls, execMs } = parseLine(line);
    if (!queryId(id) || !member(queryGroups, group) || !integer(calls) || !nonnegative(execMs))
      throw new Error('Invalid PostgreSQL statement summary');
    return { queryId: id, group, calls, execMs };
  }) : [];
}

export function dbEvidence(samples: DbSample[], statements: Statement[]) {
  const waits = new Map<string, { queryId: string | null; type: string; event: string; observations: number; estimatedBackendMs: number }>();
  const lockMs = new Map<string, number>();
  let coveredMs = 0;
  for (const [i, sample] of samples.entries()) {
    const gap = (samples[i + 1]?.at ?? sample.at) - sample.at;
    const weight = gap > 0 && gap <= 2 * dbSampleIntervalMs ? gap : 0;
    coveredMs += weight;
    for (const row of sample.waits) {
      const key = JSON.stringify([row.queryId, row.type, row.event]);
      const total = waits.get(key) ?? { queryId: row.queryId, type: row.type, event: row.event, observations: 0, estimatedBackendMs: 0 };
      total.observations += row.count;
      total.estimatedBackendMs += row.count * weight;
      waits.set(key, total);
      if (row.type === 'Lock' && row.queryId !== null)
        lockMs.set(row.queryId, (lockMs.get(row.queryId) ?? 0) + row.count * weight);
    }
  }
  return { coveredMs, waits: [...waits.values()],
    statements: statements.map(row => {
      const estimatedLockMs = lockMs.get(row.queryId) ?? 0;
      return { ...row, estimatedLockMs, estimatedExecExcludingLockMs: coveredMs > 0 && row.execMs >= estimatedLockMs
        ? row.execMs - estimatedLockMs : null };
    }) };
}
