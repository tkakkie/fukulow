import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { b1Begin, b1Denials, b1Query, b1Rows, planFacts, verifyB1 } from './b1.ts';
import { denialCases, probe } from './definer.ts';
import { member, org } from './seed.ts';

const role = 'fukulow_b1|fukulow_b1|f|f|f|f|f|f';
const rls = ['channel_members','channels','messages','users'].map(t=>t+'|t|t|t|f').join('\n');
const policy = 'a'.repeat(32);
const valid = [role,'0',rls,'0',policy];
test('B1 verifies the login, active forced RLS and invoker path',()=>{
  const facts = verifyB1(text=>{
    if (text.includes('rolbypassrls')) return role;
    if (text.includes('pg_auth_members')) return '0';
    if (text.includes('relforcerowsecurity') && text.includes('row_security_active')) return rls;
    if (text.includes('prosecdef') && text.includes('has_function_privilege')) return '0';
    if (text.includes('b1_match') && text.includes('NOT polpermissive')) return policy;
    assert.fail(text);
  },policy);
  assert.deepEqual(facts,{role,memberships:'0',rls,definers:'0',policy});
});
for (const [index,drift,message] of [
  [0,'fukulow_b1|fukulow_b1|f|t|f|f|f|f',/NOBYPASSRLS/],
  [1,'1',/memberships/],
  [2,rls.replace('messages|t|t','messages|t|f'),/forced RLS/],
  [2,rls.replace('messages|t|t|t','messages|t|t|f'),/active/],
  [3,'1',/definer/],
  [4,'',/restrictive B1 policy/],
  [4,'b'.repeat(32),/policy changed/],
] as const) {
  test(`B1 refuses drift ${index}: ${message}`,()=>{
    const output = [...valid];
    output[index] = drift;
    assert.throws(()=>verifyB1(()=>output.shift() ?? '',policy),message);
  });
}
test('B1 supplies a local literal and keeps matching inside the restrictive policy',()=>{
  const sql = readFileSync(new URL('b1.sql',import.meta.url),'utf8');
  assert.match(sql,/AS RESTRICTIVE FOR SELECT TO fukulow_b1/);
  assert.match(sql,/nullif\(current_setting\('fukulow.search_query', true\), ''\)/);
  assert.match(sql,/chr\(92\).*'%', chr\(92\) \|\| '%'\), '_', chr\(92\) \|\| '_'/s);
  assert.doesNotMatch(sql,/\bBYPASSRLS\b|SECURITY DEFINER/i);
  const literal = "a'b%_\\";
  assert.match(b1Begin(literal),/REPEATABLE READ READ ONLY/);
  assert.ok(b1Begin(literal).includes("set_config('fukulow.search_query','a''b%_\\',true)"));
  assert.doesNotMatch(b1Query(),/LIKE|normalized_body|fukulow_search_messages|\{\{/i);
  assert.match(b1Query(),/ORDER BY m.created_at DESC, m.id DESC LIMIT 20$/);
  assert.match(b1Query(member(3,2),false),/ORDER BY m.id$/);
});
test('the B1 denial runner executes the same cases with distinct actor and Organization context',()=>{
  const expected = denialCases.flatMap(c=>[false,true].map(forced=>({c,forced})));
  const output = b1Denials(text=>{
    const check = expected.shift();
    assert.ok(check);
    const {c,forced} = check;
    assert.ok(text.startsWith(b1Begin(c.query,c.context)));
    assert.ok(text.includes(b1Query(member(...c.actor),false)));
    assert.equal(text.includes('enable_seqscan=off'),forced);
    const context = c.context===null ? 't' : (c.context==='' ? '' : org(c.context))+'|t';
    return [context,...c.expect.map(probe)].join('\n');
  });
  assert.equal(output.length,2*denialCases.length);
  assert.ok(output.every(c=>JSON.stringify(c.found)===JSON.stringify(c.expected)));
  assert.equal(b1Rows(`${org(1)}|t\nrow`),'row');
});
test('plan evidence distinguishes executed PGroonga scans and reports filter/recheck counters',()=>{
  const sample = [{'Execution Time':3,Plan:{'Node Type':'Bitmap Heap Scan','Relation Name':'messages',
    'Actual Loops':1,'Actual Rows':1,'Recheck Cond':'normalized_body ~~ pattern','Filter':'organization_id = context',
    'Rows Removed by Filter':2001,'Rows Removed by Index Recheck':7,
    Plans:[{'Node Type':'Bitmap Index Scan','Index Name':'search_body','Index Cond':'normalized_body ~~ pattern',
      'Actual Rows':2009,'Actual Loops':1}]}}] as Parameters<typeof planFacts>[0];
  const facts = planFacts(sample);
  assert.equal(facts.searchIndex,true);
  assert.equal(facts.seqScanMessages,false);
  assert.deepEqual(facts.scans.map(s=>[s.rowsPerLoop,s.removedByFilterPerLoop,s.removedByRecheckPerLoop]),[[1,2001,7],[2009,0,0]]);
  sample[0].Plan.Plans![0]['Actual Loops'] = 0;
  assert.equal(planFacts(sample).searchIndex,false);
});
