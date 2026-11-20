import { readFileSync } from 'node:fs';

export const psqlArgs = ['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow'];
export const untrackedSqlArgs = ['-e', 'PGOPTIONS=-c pg_stat_statements.track=none'];

export const topStatementsSql = `
SELECT coalesce(json_agg(s ORDER BY total_exec_time DESC), '[]')
FROM (
  SELECT queryid::text, query, toplevel, calls, total_exec_time, mean_exec_time, max_exec_time,
    rows, shared_blks_hit, shared_blks_read
  FROM pg_stat_statements
  WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  ORDER BY total_exec_time DESC, queryid, userid, toplevel
  LIMIT 25
) s;`;

export const activitySql = `
WITH app AS MATERIALIZED (
  SELECT coalesce(state, 'unknown') AS state, wait_event_type, wait_event,
    CASE WHEN wait_event_type = 'Lock' THEN cardinality(pg_blocking_pids(pid)) > 0 ELSE false END AS blocked,
    extract(epoch FROM now() - xact_start) * 1000 AS age_ms
  FROM pg_stat_activity
  WHERE datname = current_database() AND usename = 'fukulow_app'
    AND backend_type = 'client backend' AND pid <> pg_backend_pid()
), ages AS (
  SELECT 'nonIdle' AS kind, age_ms FROM app WHERE state <> 'idle'
  UNION ALL
  SELECT 'idleInTransaction', age_ms FROM app WHERE state = 'idle in transaction'
), holds AS (
  SELECT kind, count(age_ms) AS count, avg(age_ms) AS mean, max(age_ms) AS peak FROM ages GROUP BY kind
), waits AS (
  SELECT state, wait_event_type AS "waitEventType", wait_event AS "waitEvent", count(*) AS count
  FROM app GROUP BY state, wait_event_type, wait_event
)
SELECT json_build_object(
  'connections', (SELECT count(*) FROM app),
  'active', (SELECT count(*) FROM app WHERE state = 'active'),
  'blocked', (SELECT count(*) FROM app WHERE blocked),
  'waits', (SELECT coalesce(json_agg(waits ORDER BY state, "waitEventType", "waitEvent"), '[]') FROM waits),
  'states', (SELECT coalesce(json_object_agg(state, n), '{}') FROM (SELECT state, count(*) AS n FROM app GROUP BY state) s),
  'holds', (SELECT coalesce(json_object_agg(kind, to_jsonb(holds) - 'kind'), '{}') FROM holds)
);`;

export type Activity = {
  connections: number;
  active: number;
  blocked: number;
  waits: { state: string; waitEventType: string | null; waitEvent: string | null; count: number }[];
  states: Record<string, number>;
  holds: Partial<Record<'nonIdle' | 'idleInTransaction', { count: number; mean: number | null; peak: number | null }>>;
};

export function parseActivity(raw: string): Activity {
  const activity = JSON.parse(raw) as Activity;
  const count = (n: number) => Number.isSafeInteger(n) && n >= 0;
  const event = (name: unknown) => name === null || typeof name === 'string';
  if (![activity.connections, activity.active, activity.blocked].every(count) ||
      activity.active > activity.connections || activity.blocked > activity.connections ||
      !Array.isArray(activity.waits) ||
      !activity.waits.every(row => typeof row.state === 'string' && event(row.waitEventType) &&
        event(row.waitEvent) && count(row.count)) ||
      activity.waits.reduce((sum, row) => sum + row.count, 0) !== activity.connections) {
    throw new Error('Incomplete DB wait sample');
  }
  return activity;
}

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function explainFixture(source: string, sql: (query: string) => string, organization: string, channels: string[]) {
  if (![organization, ...channels].every(id => uuidPattern.test(id))) throw new Error('Invalid EXPLAIN fixture IDs');
  const path = 'server/src/messages/unread.rs';
  const name = 'LIST_COUNTS_SQL';
  const statement = readFileSync(`${source}/${path}`, 'utf8').match(/\bconst LIST_COUNTS_SQL\s*:\s*&str\s*=\s*r#"([\s\S]*?)"#;/)?.[1];
  if (!statement) throw new Error('Channel-list counts statement unavailable in arm');
  const email = 'member-0@example.invalid';
  const [memberId, revision] = sql(`SELECT u.id, u.membership_revision FROM users u
    JOIN accounts a ON a.id = u.account_id
    WHERE u.organization_id = '${organization}' AND a.email = '${email}';`).split('|');
  if (!uuidPattern.test(memberId) || !/^\d+$/.test(revision)) throw new Error('Invalid EXPLAIN fixture Member');

  return {
    bindings: { path, name, organization, email, memberId, membershipRevision: revision, channelIds: channels },
    query: (timeoutMs: number) => `
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = ${timeoutMs};
SET LOCAL jit = off;
SET LOCAL ROLE fukulow_app;
SET LOCAL fukulow.organization_id = '${organization}';
PREPARE channel_list_counts(uuid, uuid, bigint, uuid[]) AS ${statement};
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
  EXECUTE channel_list_counts('${organization}', '${memberId}', ${revision}, '{${channels.join(',')}}');
ROLLBACK;`,
  };
}

export function scheduleExplain(boundary: number, fixture: ReturnType<typeof explainFixture>,
  sql: (query: string, timeoutMs: number) => Promise<string>,
) {
  const deadline = boundary + 11000;
  let pending: ReturnType<typeof capture> | undefined;
  async function capture() {
    const startedAt = Date.now();
    // Leave time for docker exec/psql startup before the next scheduled step.
    const budget = deadline - startedAt - 1000;
    let plan: unknown;
    try {
      if (budget > 0) plan = JSON.parse(await sql(fixture.query(budget), deadline - startedAt));
    } catch {
      // SQL errors can include bound data.
    }
    const finishedAt = Date.now();
    const captured = plan !== undefined && finishedAt <= deadline;
    return { status: captured ? 'CAPTURED' : 'NOT CAPTURED', boundary, deadline, startedAt, finishedAt,
      reason: captured ? undefined : 'EXPLAIN failed or exceeded the 250/s drain', bindings: fixture.bindings, plan };
  }
  const timer = setTimeout(() => { pending = capture(); }, Math.max(0, boundary - Date.now()));
  return async () => {
    clearTimeout(timer);
    return await pending ?? { status: 'NOT CAPTURED', reason: 'Generator stopped before the 250/s boundary', bindings: fixture.bindings };
  };
}
