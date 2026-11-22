// #519: the seed is one bulk transaction, so before this step the planner had no statistics
// (reltuples -1). sqlx's prepared Session lookup then switched to a generic plan that
// scanned every Member. Both arms run VACUUM (ANALYZE) after the seed COMMIT and before
// any load. A run starts only if the statistics are fresh and the Session lookup uses
// the account index under both custom and generic plans. No server code, schema or
// index changes: this is a harness condition, recorded as `harnessCondition` and `seed-statistics.json`.
export const condition = 'seed-analyzed: VACUUM (ANALYZE) after the seed COMMIT, before load (#519); not directly comparable with earlier runs';

// The Session lookup from server/src/auth.rs, identical at B 956f91e, A 7e3762a and main.
export const sessionLookup = 'SELECT s.account_id, u.id, u.name, u.role, o.name, u.membership_revision '
  + 'FROM account_sessions s LEFT JOIN users u ON u.account_id = s.account_id '
  + 'AND u.organization_id = $2 AND u.deactivated_at IS NULL '
  + 'LEFT JOIN organizations o ON o.organization_id = u.organization_id '
  + 'WHERE s.token_hash = $1 AND s.expires_at > now()';

export const tables = ['accounts', 'users', 'account_sessions', 'organizations', 'channels'] as const;
type Table = typeof tables[number];
export type TableStats = { relname: string; reltuples: number; last_vacuum: string | null; last_analyze: string | null };

// Seeded rows: 4,000 Members + owner + reader; one Session per Member (owner and reader add more).
export function minimumRows(members: number, channels: number): Record<Table, number> {
  return { accounts: members + 2, users: members + 2, account_sessions: members, organizations: 2, channels };
}

export const statsQuery = `SELECT coalesce(json_agg(json_build_object('relname',c.relname,'reltuples',c.reltuples,
  'last_vacuum',s.last_vacuum,'last_analyze',s.last_analyze) ORDER BY c.relname),'[]')
  FROM pg_class c JOIN pg_stat_user_tables s ON s.relid=c.oid
  WHERE s.schemaname='public' AND c.relname IN (${tables.map(t => `'${t}'`).join(',')})`;

export function statsReasons(rows: TableStats[], startedAt: string, minimum: Record<Table, number>): string[] {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return ['invalid VACUUM start time'];
  const reasons: string[] = [];
  for (const table of tables) {
    const row = rows.find(r => r.relname === table);
    if (!row) { reasons.push(`${table}: no statistics row`); continue; }
    const fresh = (at: string | null) => at !== null && Date.parse(at) >= started;
    if (!fresh(row.last_vacuum)) reasons.push(`${table}: not vacuumed by this step`);
    if (!fresh(row.last_analyze)) reasons.push(`${table}: not analyzed by this step`);
    if (!(row.reltuples >= minimum[table])) reasons.push(`${table}: reltuples ${row.reltuples} < ${minimum[table]}`);
  }
  return reasons;
}

// Runs as the runtime role under RLS with the statement-local Organization context, like the app.
export function planQuery(organization: string, token: string, mode: 'force_custom_plan' | 'force_generic_plan') {
  if (!/^[0-9a-f-]{36}$/.test(organization) || !/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid plan check input');
  return `BEGIN READ ONLY;
SELECT set_config('fukulow.organization_id','${organization}',true) \\g /dev/null
SET LOCAL plan_cache_mode = ${mode};
PREPARE session_lookup(bytea, uuid) AS ${sessionLookup};
EXPLAIN (FORMAT JSON) EXECUTE session_lookup(sha256(convert_to('${token}','UTF8')), '${organization}');
COMMIT;`;
}

type PlanNode = { 'Node Type': string; 'Parent Relationship'?: string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
const walk = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(walk)];
// The join itself, without RLS policy SubPlans/InitPlans (the organizations policy reads users too).
const joinNodes = (node: PlanNode): PlanNode[] =>
  [node, ...(node.Plans ?? []).filter(c => !['SubPlan', 'InitPlan'].includes(c['Parent Relationship'] ?? '')).flatMap(joinNodes)];

// The good plan reads users through users_account_id. A scan of every Member
// (Seq Scan, or the users_directory_order index on main) is the #519 artifact.
export function planReasons(explain: unknown): string[] {
  const root = (explain as { Plan?: PlanNode }[] | undefined)?.[0]?.Plan;
  if (!root || typeof root['Node Type'] !== 'string') return ['no plan'];
  const nodes = walk(root);
  const reasons: string[] = [];
  const joined = joinNodes(root).filter(n => n['Relation Name'] === 'users').length;
  if (joined !== 1) reasons.push(`users joined ${joined} times`);
  // Every users read, including policy SubPlans, must use the account index.
  const users = nodes.filter(n => n['Relation Name'] === 'users');
  for (const n of users) {
    const index = n['Node Type'] === 'Bitmap Heap Scan' ? walk(n).find(c => c['Index Name'])?.['Index Name'] : n['Index Name'];
    if (index !== 'users_account_id') reasons.push(`users read by ${n['Node Type']}${n['Index Name'] ? ' on ' + n['Index Name'] : ''}`);
  }
  for (const n of nodes) {
    if (n['Node Type'] === 'Seq Scan' && ['users', 'account_sessions'].includes(n['Relation Name'] ?? '')) reasons.push(`Seq Scan on ${n['Relation Name']}`);
  }
  return reasons;
}
