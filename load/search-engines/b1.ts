import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { denialCases, probe } from './definer.ts';
import { begin } from './queries.ts';
import { literal, member, org } from './seed.ts';

export const b1Role = 'fukulow_b1';
export const b1SearchPath = 'pg_catalog, pg_temp';
const tables = ['channel_members','channels','messages','users'];
export const b1RoleFacts = `${b1Role}|${b1Role}|f|f|f|f|f|f`;
export const b1RlsFacts = tables.map(table=>`${table}|t|t|t|f`).join('\n');
const querySql = readFileSync(new URL('b1-query.sql',import.meta.url),'utf8').trimEnd();

export function b1Query(actor = member(1,2), page = true) {
  return querySql.replace('{{actor}}',literal(actor))
    .replace('{{columns}}',page ? 'm.id, m.created_at, m.body' : 'm.id')
    .replace('{{order}}',page ? 'm.created_at DESC, m.id DESC LIMIT 20' : 'm.id');
}
type Context = number | null | '';
const queryContext = 'fukulow.search_query';
export function b1Begin(query: string, context: Context = 1) {
  const setting = context===null ? '' : `set_config('fukulow.organization_id',${literal(context==='' ? '' : org(context))},true),`;
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT ${setting}set_config('${queryContext}',${literal(query)},true) IS NOT NULL;
`;
}
export function b1Rows(output: string, context: Context = 1) {
  const [settings,...rows] = output.split('\n');
  const expected = context===null ? 't' : (context==='' ? '' : org(context))+'|t';
  assert.equal(settings,expected,'B1 transaction-local context output');
  return rows.join('\n');
}

export function verifyB1(sql: (text: string)=>string, policy?: string) {
  const role = sql(`SELECT current_user,session_user,rolsuper,rolbypassrls,rolinherit,rolcreatedb,rolcreaterole,rolreplication
    FROM pg_roles WHERE rolname=current_user;`);
  assert.equal(role,b1RoleFacts,'B1 requires the dedicated non-superuser NOBYPASSRLS login');
  const memberships = sql(`SELECT count(*) FROM pg_auth_members WHERE member=current_user::regrole OR roleid=current_user::regrole;`);
  assert.equal(memberships,'0','B1 role has memberships');
  const rls = sql(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,row_security_active(c.oid),c.relowner=current_user::regrole
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN (${tables.map(literal).join(',')}) ORDER BY c.relname;`);
  assert.equal(rls,b1RlsFacts,'B1 requires active, enabled and forced RLS on every search table');
  const definers = sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(p.oid,'EXECUTE');`);
  assert.equal(definers,'0','B1 role can execute a public definer');
  const installed = sql(`SELECT md5(pg_get_expr(polqual,polrelid)) FROM pg_policy
    WHERE polrelid='public.messages'::regclass AND polname='b1_match' AND NOT polpermissive
      AND polcmd='r' AND polroles=ARRAY[current_user::regrole::oid];`);
  assert.match(installed,/^[a-f0-9]{32}$/,'Missing restrictive B1 policy');
  assert.equal(installed,policy ?? installed,'B1 policy changed between databases');
  return {role,memberships,rls,definers,policy:installed};
}

export function b1Denials(sql: (text: string)=>string) {
  return denialCases.flatMap(c => [false,true].map(forced => {
    const settings = forced ? 'SET LOCAL enable_seqscan=off;\n' : '';
    const rows = b1Rows(sql(b1Begin(c.query,c.context)+settings+b1Query(member(...c.actor),false)+';\nCOMMIT;'),c.context);
    return {case:c.name,forced,found:rows ? rows.split('\n') : [],expected:c.expect.map(probe)};
  }));
}

export function b1Cleanup(sql: (text: string)=>string) {
  // Restore one setting at a time on the same connection after COMMIT.
  const count = 'SELECT count(*) FROM public.messages;';
  const rls = sql(`${b1Begin('denialprobe')}SELECT count(*) FROM public.messages WHERE organization_id='${org(2)}';
SELECT count(*) FROM public.messages WHERE organization_id='${org(1)}';
COMMIT;
${count}
${b1Begin('denialprobe',null)}${count}
COMMIT;
${begin()}${count}
COMMIT;`);
  assert.equal(rls,`${org(1)}|t\n0\n7\n0\nt\n0\n${org(1)}\n0`,'B1 RLS isolation or context cleanup failed');
  return rls;
}

type PlanNode = {'Node Type':string; 'Actual Loops':number; 'Actual Rows':number;
  'Index Name'?:string; 'Relation Name'?:string; 'Index Cond'?:string; 'Recheck Cond'?:string; 'Filter'?:string;
  'Rows Removed by Filter'?:number; 'Rows Removed by Index Recheck'?:number; Plans?:PlanNode[]};
export function planFacts(explain: [{Plan:PlanNode; 'Execution Time':number}]) {
  const flatten = (node: PlanNode): PlanNode[] => [node,...(node.Plans ?? []).flatMap(flatten)];
  const nodes = flatten(explain[0].Plan);
  assert.ok(Number.isFinite(explain[0]['Execution Time']),'Missing EXPLAIN execution time');
  assert.ok(nodes.some(n=>n['Relation Name']==='messages'),'Missing Messages plan');
  return {executionMs:explain[0]['Execution Time'],
    searchIndex:nodes.some(n=>n['Index Name']==='search_body' && n['Actual Loops']>0 && !!n['Index Cond']),
    seqScanMessages:nodes.some(n=>n['Relation Name']==='messages' && n['Node Type']==='Seq Scan'),
    // Counts are per-loop averages across all reasons for rejection, not tenant-specific counts.
    scans:nodes.filter(n=>n['Relation Name']==='messages' || n['Index Name']==='search_body').map(n=>({
      node:n['Node Type'],index:n['Index Name'],loops:n['Actual Loops'],rowsPerLoop:n['Actual Rows'],
      indexCond:n['Index Cond'],recheckCond:n['Recheck Cond'],filter:n.Filter,
      removedByFilterPerLoop:n['Rows Removed by Filter'] ?? 0,
      removedByRecheckPerLoop:n['Rows Removed by Index Recheck'] ?? 0,
    }))};
}

export function b1Plan(sql: (text: string)=>string, query: string, record: (explain: unknown)=>void,
  {settings = '', actor = member(1,2), prepared = false} = {}) {
  const page = b1Query(actor);
  const prepare = prepared ? `PREPARE b1_search_page AS ${page};\n` : '';
  const explain = JSON.parse(b1Rows(sql(b1Begin(query)+settings+prepare+
    'EXPLAIN (ANALYZE, BUFFERS, SETTINGS, VERBOSE, FORMAT JSON) '+
    (prepared ? 'EXECUTE b1_search_page' : page)+';\nCOMMIT;')));
  record(explain);
  return planFacts(explain);
}

export function b1ForcedDenialPlan(sql: (text: string)=>string, record: (explain: unknown)=>void) {
  const facts = b1Plan(sql,'denialprobe',record,{settings:'SET LOCAL enable_seqscan=off;\n',actor:member(1,1)});
  assert.ok(facts.searchIndex,'B1 forced denial plan did not use search_body');
}

export function b1TimingFixture(sql: (arm: 'few'|'many', text: string)=>string, classes: number, foreignRowsPerClass: number) {
  const text = `SELECT count(*) FILTER (WHERE organization_id='${org(1)}'),
    count(*) FILTER (WHERE organization_id='${org(2)}'),
    md5(string_agg(organization_id || '|' || id || '|' || octet_length(body) || '|' ||
      CASE WHEN organization_id='${org(1)}' THEN md5(body) ELSE '' END, ',' ORDER BY organization_id,id))
    FROM public.messages;`;
  const few = sql('few',text);
  const many = sql('many',text);
  const [visible,foreign,fingerprint] = few.split('|');
  assert.equal(visible,String(classes),'B1 timing fixture visible row count');
  assert.equal(foreign,String(classes*foreignRowsPerClass),'B1 timing fixture foreign row count');
  assert.match(fingerprint ?? '',/^[a-f0-9]{32}$/,'Missing B1 timing fixture fingerprint');
  assert.equal(many,few,'B1 timing fixture arms differ in IDs, row counts, byte lengths or visible bodies');
  return {visibleRows:Number(visible),foreignRows:Number(foreign),fingerprint};
}
