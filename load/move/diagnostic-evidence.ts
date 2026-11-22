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
// The server tags the Part D read routes too. The second-Organization reader shares the
// Channel-list route, so Channel-list events are split by their Organization.
const serverLanes = [...lanes, 'channels', 'topics', 'reader'] as const;
const scenarios = [...lanes, 'reader', 'channels', 'topic0', 'topic1', 'topic2', 'topic3'] as const;
type Lane = typeof lanes[number];
type ServerLane = typeof serverLanes[number];
type Scenario = typeof scenarios[number];
const sendAccessDetails = ['send_access_channel_sql', 'send_access_members_sql', 'send_access_grants_sql'] as const;
const sendChildren = [
  'write_pool_acquire', 'send_begin_sql', 'send_set_organization_sql', 'send_visibility_sql', 'send_history_sql',
  'send_existing_sql', 'send_rollback_sql', 'send_rollback_connection_return', 'send_receipt_pool_acquire',
  'send_receipt_begin_sql', 'send_receipt_set_organization_sql', 'send_receipt_access_sql', 'send_receipt_history_sql',
  'send_receipt_lookup_sql', 'send_receipt_end_sql', 'send_mention_extract', 'send_dm_pair_sql',
  'send_dm_prepare_members', 'send_dm_members_sql', 'send_dm_grants_sql', 'send_dm_accept_mentions',
  'send_dm_peer_sql', 'send_dm_discovery_counters_sql', 'send_dm_discovery_sql',
  'send_access_sql', ...sendAccessDetails, 'send_archived_receipt_sql',
  'send_reply_parent_before', 'channel_advisory_sql', 'send_reply_parent_after', 'send_sequence_sql',
  'send_topic_insert_sql', 'send_topic_lookup_sql', 'send_message_insert_sql', 'send_search_terms_sql',
  'send_channel_log_sql', 'send_mention_insert_sql', 'send_mention_identities_sql', 'send_mention_hydrate',
  'send_topic_record', 'send_notification_arm', 'commit_sql', 'send_commit_connection_return',
  'send_activity_schedule', 'send_notification_schedule',
] as const;
const phases = ['before_admission', 'channel_admission_wait', 'global_admission_wait', 'admitted_work', 'pool_acquire',
  ...sendChildren, 'move_access_sql', 'move_chain_lookup', 'move_apply',
  'topic_visible_scoped', 'topic_dm_check', 'topic_barrier', 'topic_page_tx', 'topic_page_sql',
  'channel_list_total', 'channel_visible_sql', 'channel_history_sql', 'channel_counts_sql'] as const;
const reasons = ['global_queue_full', 'channel_queue_full', 'channel_admission_timeout', 'global_admission_timeout',
  'channel_admission_closed', 'global_admission_closed', 'watermark_channel_timeout', 'watermark_global_timeout',
  'watermark_channel_closed', 'watermark_global_closed',
  'limiter_duplicate_waiters_cap', 'limiter_pending_cap', 'limiter_member_buckets_cap', 'shutdown', 'unclassified'] as const;
const member = <T extends string>(list: readonly T[], input: unknown): input is T => list.includes(input as T);

export type Organizations = { partD: string; reader: string };
type Timing = { at: number; lane: ServerLane; phase: typeof phases[number]; us: number; interrupted: boolean;
  requestId?: number; sendChildren?: number };
type PhaseSummary = ReturnType<typeof distributions> & { interrupted: number; incomplete?: number };

function serverLane(lane: unknown, organization: unknown, organizations?: Organizations): ServerLane | undefined {
  if (lane !== 'channels') return member(serverLanes, lane) && lane !== 'reader' ? lane : undefined;
  if (organizations && organization === organizations.partD) return 'channels';
  if (organizations && organization === organizations.reader) return 'reader';
  return undefined;
}

export function appEvidence(log: string, organizations?: Organizations) {
  const timing: Timing[] = [];
  const unavailable: { at: number; lane: ServerLane; reason: typeof reasons[number] }[] = [];
  for (const line of log.split('\n')) {
    if (!line.includes('move_diag_')) continue;
    const { timestamp, fields } = parseLine(line);
    const at = time(timestamp);
    const { event, lane: tagged, organization, phase, us, interrupted, reason, request_id, send_children } = object(fields);
    const lane = serverLane(tagged, organization, organizations);
    if (!Number.isFinite(at) || !lane) continue;
    if (event === 'move_diag_timing' && member(phases, phase) && nonnegative(us) && typeof interrupted === 'boolean')
      timing.push({ at, lane, phase, us, interrupted, requestId: integer(request_id) ? request_id : undefined,
        sendChildren: integer(send_children) ? send_children : undefined });
    if (event === 'move_diag_503' && member(reasons, reason)) unavailable.push({ at, lane, reason });
  }
  const byLane = Object.fromEntries(serverLanes.map(lane => [lane, {
    reasons: Object.fromEntries(reasons.map(reason => [reason, unavailable.filter(sample => sample.lane === lane && sample.reason === reason).length])),
    phasesUs: Object.fromEntries<PhaseSummary>(phases.flatMap(phase => {
      const points = timing.filter(sample => sample.lane === lane && sample.phase === phase);
      return points.length ? [[phase, { ...distributions(points.filter(sample => !sample.interrupted).map(sample => sample.us)),
        interrupted: points.filter(sample => sample.interrupted).length }]] : [];
    })),
  }]));
  const send = sendBreakdown(timing);
  if (send) byLane.send.phasesUs.send_unattributed = send;
  return {
    timing, unavailable, byLane,
    writeUnavailable: unavailable.filter(sample => member(lanes, sample.lane)).length,
  };
}

function sendBreakdown(timing: Timing[]) {
  const groups = new Map<number, { parents: Timing[]; children: Timing[] }>();
  let incomplete = 0, interrupted = 0;
  let hasBreakdown = false;
  for (const sample of timing) {
    if (sample.lane !== 'send' || (sample.phase !== 'admitted_work' && !member(sendChildren, sample.phase))) continue;
    if (sample.requestId === undefined) {
      incomplete++;
      continue;
    }
    hasBreakdown = true;
    const group = groups.get(sample.requestId) ?? { parents: [], children: [] };
    groups.set(sample.requestId, group);
    (sample.phase === 'admitted_work' ? group.parents : group.children).push(sample);
  }
  if (!hasBreakdown) return undefined;
  const residuals: number[] = [];
  for (const { parents, children } of groups.values()) {
    if (parents.length === 1 && parents[0].interrupted) {
      interrupted++;
      continue;
    }
    const parent = parents[0];
    const childUs = children.reduce((sum, child) => member(sendAccessDetails, child.phase) ? sum : sum + child.us, 0);
    // Access details overlap send_access_sql; pool_acquire overlaps the acquisition phases.
    if (parents.length !== 1 || children.length === 0 || parent.sendChildren !== children.length ||
        new Set(children.map(child => child.phase)).size !== children.length ||
        children.some(child => child.interrupted) || childUs > parent.us) {
      incomplete++;
      continue;
    }
    residuals.push(parent.us - childUs);
  }
  return { ...distributions(residuals), interrupted, incomplete };
}

// A few incomplete requests (for example a cancelled or interrupted child) are reported, not fatal; more than 1% makes the
// breakdown unusable because the residual would describe a selected subset.
export function sendTimingProblems(app: ReturnType<typeof appEvidence> | null | undefined) {
  const breakdown = app?.byLane.send.phasesUs.send_unattributed;
  return breakdown?.count && (breakdown.incomplete ?? 0) <= breakdown.count * 0.01 ? [] : ['send admitted-work breakdown'];
}

// Every phase of an enabled Part D read lane needs finished (non-interrupted) samples.
export const requiredReadPhases = {
  channels: ['channel_list_total', 'channel_visible_sql', 'channel_history_sql', 'channel_counts_sql'],
  topics: ['topic_visible_scoped', 'topic_dm_check', 'topic_barrier', 'topic_page_tx', 'topic_page_sql'],
} as const;

export function readTimingProblems(byLane: Partial<Record<string, { phasesUs: Record<string, { count: number }> }>> | undefined,
  readLanes: string) {
  return (['channels', 'topics'] as const).filter(lane => readLanes === 'all' || readLanes === lane).flatMap(lane => {
    const absent = requiredReadPhases[lane].filter(phase => (byLane?.[lane]?.phasesUs[phase]?.count ?? 0) === 0);
    return absent.length ? [`${lane === 'channels' ? 'Channel-list' : 'Topic-list'} timings (${absent.join(', ')})`] : [];
  });
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
export type Statement = { queryId: string; group: string; calls: number; execMs: number; text: string | null };
const waitTypes = ['Lock', 'LWLock', 'IO', 'BufferPin', 'Client', 'IPC', 'Timeout', 'Extension', 'Activity', 'running'] as const;
// First match wins. Read-lane groups follow the write groups so those keep their membership;
// markers avoid literals and $n numbers: pg_stat_statements replaces literals with $n and may renumber.
export const statementGroups: readonly { group: string; like?: readonly string[]; regex?: string }[] = [
  { group: 'channel_advisory_read', like: ['%pg_advisory_xact_lock_shared(%'] },
  { group: 'channel_advisory_write', like: ['%pg_advisory_xact_lock(%'] },
  { group: 'move_update', like: ['%UPDATE messages SET topic_id=%'] },
  { group: 'move_chain_lookup', like: ['%UNION ALL (SELECT id, reply_to_id, seq, version, sender, topic_id FROM messages%'] },
  { group: 'send_insert', like: ['INSERT INTO messages %'] },
  { group: 'row_lock_sql', regex: 'FOR (NO KEY UPDATE|KEY SHARE|UPDATE|SHARE)' },
  { group: 'channel_list_counts', like: ['%unread_topics AS MATERIALIZED (%'] },
  { group: 'channel_list_visible', like: ['%::bool IS NULL OR (c.archived_at IS NOT NULL)=%'] },
  { group: 'topic_page', like: ['%candidates AS (%', '%topic_read_positions%'] },
  { group: 'dm_check', like: ['SELECT EXISTS (SELECT % FROM channels WHERE organization_id=% AND id=% AND kind=%'] },
  { group: 'watermark_seq', like: ['SELECT seq FROM channel_message_sequences WHERE organization_id = % AND channel_id = %'] },
  { group: 'history_page_seq', like: ['SELECT seq, mutation_seq FROM channel_message_sequences WHERE organization_id=% AND channel_id=%'] },
  // Shared by many routes (Topic-list pre-checks, Move pre-check, auth on every request).
  { group: 'member_visibility', like: ['%SELECT visible FROM (SELECT u.id, u.membership_revision, EXISTS (SELECT %'] },
  { group: 'auth_session', like: ['SELECT s.account_id, u.id, %FROM account_sessions s %'] },
  { group: 'organization_history', like: ['SELECT history_generation FROM organizations WHERE %'] },
];
const queryGroups = [...statementGroups.map(rule => rule.group), 'other'];
const condition = (rule: typeof statementGroups[number]) =>
  rule.regex ? `query ~* '${rule.regex}'` : rule.like!.map(pattern => `query LIKE '${pattern}'`).join(' AND ');

export function statementGroupSql() {
  return `CASE ${statementGroups.map(rule => `WHEN ${condition(rule)} THEN '${rule.group}'`).join('\n  ')} ELSE 'other' END`;
}

// The same rules as statementGroupSql, for tests against normalized statement text.
export function statementGroup(query: string) {
  const like = (pattern: string) => new RegExp('^' + [...pattern].map(c => c === '%' ? '[\\s\\S]*' : c === '_' ? '[\\s\\S]'
    : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + '$');
  return statementGroups.find(rule => rule.regex ? new RegExp(rule.regex, 'i').test(query)
    : rule.like!.every(pattern => like(pattern).test(query)))?.group ?? 'other';
}

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
    const { id, group, calls, execMs, text = null } = parseLine(line);
    if (!queryId(id) || !member(queryGroups, group) || !integer(calls) || !nonnegative(execMs) ||
        !(text === null || (typeof text === 'string' && [...text].length <= 200)))
      throw new Error('Invalid PostgreSQL statement summary');
    return { queryId: id, group, calls, execMs, text };
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
