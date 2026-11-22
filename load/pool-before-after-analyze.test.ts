import test from 'node:test';
import assert from 'node:assert/strict';
import { minimumRows, planQuery, planReasons, statsQuery, statsReasons, tables, type TableStats } from './pool-before-after-analyze.ts';

const scan = (type: string, relation?: string, index?: string, plans?: object[], cond?: string) =>
  ({ 'Node Type': type, ...(relation ? { 'Relation Name': relation } : {}), ...(index ? { 'Index Name': index } : {}),
    ...(index === 'users_account_id' ? { 'Index Cond': cond ?? '(account_id = s.account_id)' } : {}), ...(plans ? { Plans: plans } : {}) });
const lookup = (users: object) => [{ Plan: scan('Nested Loop', undefined, undefined, [
  scan('Nested Loop', undefined, undefined, [scan('Index Scan', 'account_sessions', 'account_sessions_pkey'), users]),
  scan('Index Scan', 'organizations', 'organizations_pkey'),
]) }];

test('accepts the Session lookup through users_account_id, including a bitmap scan', () => {
  assert.deepEqual(planReasons(lookup(scan('Index Scan', 'users', 'users_account_id'))), []);
  assert.deepEqual(planReasons(lookup(scan('Bitmap Heap Scan', 'users', undefined, [scan('Bitmap Index Scan', undefined, 'users_account_id')]))), []);
});

test('accepts an RLS policy SubPlan that also reads users through users_account_id', () => {
  const policy = { ...scan('Index Scan', 'users', 'users_account_id'), 'Parent Relationship': 'SubPlan' };
  const plan = [{ Plan: scan('Nested Loop', undefined, undefined, [
    scan('Nested Loop', undefined, undefined, [scan('Index Scan', 'account_sessions', 'account_sessions_pkey'), scan('Index Scan', 'users', 'users_account_id')]),
    scan('Bitmap Heap Scan', 'organizations', undefined, [scan('Bitmap Index Scan', undefined, 'organizations_pkey'), policy]),
  ]) }];
  assert.deepEqual(planReasons(plan), []);
  const badPolicy = structuredClone(plan); (badPolicy[0].Plan.Plans![1] as { Plans: object[] }).Plans[1] = { ...scan('Seq Scan', 'users'), 'Parent Relationship': 'SubPlan' };
  assert.deepEqual(planReasons(badPolicy), ['users read by Seq Scan', 'Seq Scan on users']);
});

test('rejects users_account_id walked without the Session account bound', () => {
  const unbounded = ['users_account_id not bounded by s.account_id'];
  assert.deepEqual(planReasons(lookup(scan('Index Scan', 'users', 'users_account_id', undefined, ''))), unbounded);
  assert.deepEqual(planReasons(lookup(scan('Index Only Scan', 'users', 'users_account_id', undefined, '(organization_id = $2)'))), unbounded);
  assert.deepEqual(planReasons(lookup(scan('Index Scan', 'users', 'users_account_id', undefined, "(account_id = (NULLIF(current_setting('fukulow.account_id'::text, true), ''::text))::uuid)"))), unbounded);
  assert.deepEqual(planReasons(lookup(scan('Bitmap Heap Scan', 'users', undefined, [scan('Bitmap Index Scan', undefined, 'users_account_id', undefined, '')]))), unbounded);
});

test('rejects a BitmapOr that pairs an account seek with a whole-Organization read', () => {
  const policySeek = scan('Bitmap Index Scan', undefined, 'users_account_id', undefined, "(account_id = (NULLIF(current_setting('fukulow.account_id'::text, true), ''::text))::uuid)");
  const orgRead = scan('Bitmap Index Scan', undefined, 'users_directory_order');
  assert.deepEqual(planReasons(lookup(scan('Bitmap Heap Scan', 'users', undefined, [scan('BitmapOr', undefined, undefined, [policySeek, orgRead])]))),
    ['users read by Bitmap Heap Scan']);
  const orgSeek = scan('Bitmap Index Scan', undefined, 'users_account_id', undefined, '(organization_id = $2)');
  assert.deepEqual(planReasons(lookup(scan('Bitmap Heap Scan', 'users', undefined, [scan('BitmapOr', undefined, undefined,
    [scan('Bitmap Index Scan', undefined, 'users_account_id'), orgSeek])]))), ['users_account_id not bounded by s.account_id']);
  assert.deepEqual(planReasons(lookup(scan('Bitmap Heap Scan', 'users', undefined, [scan('BitmapOr', undefined, undefined, [])]))), ['users read by Bitmap Heap Scan']);
});

test('rejects the #519 generic plan and other full Member scans', () => {
  assert.deepEqual(planReasons(lookup(scan('Index Only Scan', 'users', 'users_directory_order'))), ['users read by Index Only Scan on users_directory_order']);
  assert.deepEqual(planReasons(lookup(scan('Seq Scan', 'users'))), ['users read by Seq Scan', 'Seq Scan on users']);
  assert.deepEqual(planReasons(lookup(scan('Bitmap Heap Scan', 'users', undefined, [scan('Bitmap Index Scan', undefined, 'users_directory_order')]))),
    ['users read by Bitmap Heap Scan']);
  const sessions = [{ Plan: scan('Nested Loop', undefined, undefined, [scan('Seq Scan', 'account_sessions'), scan('Index Scan', 'users', 'users_account_id')]) }];
  assert.deepEqual(planReasons(sessions), ['Seq Scan on account_sessions']);
  assert.deepEqual(planReasons([{ Plan: scan('Index Scan', 'account_sessions', 'account_sessions_pkey') }]), ['users joined 0 times']);
  assert.deepEqual(planReasons([]), ['no plan']);
  assert.deepEqual(planReasons(undefined), ['no plan']);
});

const minimum = minimumRows(4000, 200);
const fresh = (): TableStats[] => tables.map(relname => ({ relname, reltuples: minimum[relname] + 1,
  last_vacuum: '2026-11-22T10:00:01.000001+09:00', last_analyze: '2026-11-22T10:00:01.500001+09:00', vacuumed_after_start: true, analyzed_after_start: true }));

test('accepts statistics refreshed by this step', () => {
  assert.deepEqual(statsReasons(fresh(), minimum), []);
});

test('rejects missing, stale and unanalyzed statistics', () => {
  assert.deepEqual(statsReasons(fresh().filter(r => r.relname !== 'users'), minimum), ['users: no statistics row']);
  const stale = fresh(); stale[0].analyzed_after_start = false; stale[0].last_vacuum = null; stale[0].vacuumed_after_start = null;
  assert.deepEqual(statsReasons(stale, minimum), ['accounts: not vacuumed by this step', 'accounts: not analyzed by this step']);
  const never = fresh(); never[1].reltuples = -1;
  assert.deepEqual(statsReasons(never, minimum), ['users: reltuples -1 < 4002']);
});

test('freshness is compared in SQL against a validated timestamptz', () => {
  const sql = statsQuery('2026-11-22 02:23:55.343933+00');
  assert.match(sql, /s\.last_vacuum >= '2026-11-22 02:23:55\.343933\+00'::timestamptz/);
  assert.match(sql, /s\.last_analyze >= '2026-11-22 02:23:55\.343933\+00'::timestamptz/);
  assert.throws(() => statsQuery("now()'; DROP"), /Invalid VACUUM start time/);
  assert.throws(() => statsQuery('not a time'), /Invalid VACUUM start time/);
});

test('plan check runs both plan modes as a statement-local Organization context', () => {
  const org = '0193a5b2-0000-7000-8000-000000000001', token = 'a'.repeat(64);
  for (const mode of ['force_custom_plan', 'force_generic_plan'] as const) {
    const sql = planQuery(org, token, mode);
    assert.match(sql, new RegExp(`SET LOCAL plan_cache_mode = ${mode};`));
    assert.match(sql, /set_config\('fukulow\.organization_id','0193a5b2-0000-7000-8000-000000000001',true\)/);
    assert.match(sql, /EXPLAIN \(FORMAT JSON\) EXECUTE session_lookup/);
    assert.match(sql, /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;/);
    assert.match(sql, /ROLLBACK;$/);
  }
  assert.throws(() => planQuery("x'; DROP", token, 'force_custom_plan'), /Invalid plan check input/);
  assert.throws(() => planQuery(org, 'z'.repeat(64), 'force_generic_plan'), /Invalid plan check input/);
});
