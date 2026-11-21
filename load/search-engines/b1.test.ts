import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { b1Begin, b1Cleanup, b1Denials, b1ForcedDenialPlan, b1Plan, b1Query, b1Rows, b1TimingFixture, planFacts, verifyB1 } from './b1.ts';
import { denialCases, probe } from './definer.ts';
import { member, org } from './seed.ts';

const role = 'fukulow_b1|fukulow_b1|f|f|f|f|f|f';
const rls = ['channel_members','channels','messages','users'].map(t=>t+'|t|t|t|f').join('\n');
const policy = 'a'.repeat(32);
const valid = [role,'0',rls,'0',policy];
const rlsProbe = (text: string) => {
  assert.match(text,/c\.relforcerowsecurity,row_security_active\(c\.oid\),c\.relowner\s*=\s*current_user::regrole/);
  assert.match(text,/n\.nspname='public' AND c\.relname IN \('channel_members','channels','messages','users'\)/);
};
test('B1 verifies the login, active forced RLS and invoker path',()=>{
  const facts = verifyB1(text=>{
    if (text.includes('rolbypassrls')) return role;
    if (text.includes('pg_auth_members')) return '0';
    if (text.includes('FROM pg_class')) { rlsProbe(text); return rls; }
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
  [2,rls.replace('messages|t|t|t|f','messages|t|t|t|t'),/forced RLS/],
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
  assert.doesNotMatch(sql,/\bBYPASSRLS\b|SECURITY DEFINER/i);
  const literal = "a'b%_\\";
  assert.match(b1Begin(literal),/REPEATABLE READ READ ONLY/);
  assert.ok(b1Begin(literal).includes("set_config('fukulow.search_query','a''b%_\\',true)"));
  assert.doesNotMatch(b1Query(),/LIKE|normalized_body|fukulow_search_messages|\{\{/i);
  assert.match(b1Query(),/ORDER BY m.created_at DESC, m.id DESC LIMIT 20$/);
  assert.match(b1Query(member(3,2),false),/ORDER BY m.id$/);
});
test('B1 policy denies absent queries with a non-NULL LIKE pattern and escapes literals',t=>{
  const sql = readFileSync(new URL('b1.sql',import.meta.url),'utf8');
  const predicate = sql.split('AS RESTRICTIVE FOR SELECT TO fukulow_b1 USING (')[1]?.split('\n);')[0];
  const pattern = predicate?.match(/\bnormalized_body\s+LIKE\s+([\s\S]+?)\s+ESCAPE chr\(92\)/i)?.[1];
  assert.ok(predicate && pattern);
  // Execute the policy's portable scalar expression with the two PostgreSQL functions supplied by the test.
  const db = new DatabaseSync(':memory:');
  t.after(()=>db.close());
  let query: string|null = null;
  db.function('current_setting',(key,missingOk)=>{
    assert.equal(key,'fukulow.search_query');
    assert.equal(missingOk,1);
    return query;
  });
  db.function('chr',code=>String.fromCodePoint(Number(code)));
  const matches = db.prepare(`SELECT (${predicate}) AS matched, (${pattern}) AS pattern FROM (SELECT ? AS normalized_body)`);
  for (const [literal,body,decoy] of [['x%y','prefix x%y suffix','x middle y'],['a_b','a_b','acb'],
    ['c\\d','c\\d','cd'],['ab\\','ab\\y','abz'],['\\%_','\\%_','\\xy']]) {
    query = literal!;
    assert.equal(matches.get(body!)?.matched,1,literal);
    assert.equal(matches.get(decoy!)?.matched,0,literal);
  }
  for (query of ['',null]) {
    const row = matches.get('any body');
    assert.equal(row?.pattern,'%%','B1 LIKE pattern must stay non-NULL without query context');
    assert.equal(row?.matched,0);
  }
  assert.doesNotMatch(pattern,/\bnullif\s*\(/i);
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
const samplePlan = (index = 'search_body') => [{'Execution Time':3,Plan:{'Node Type':'Bitmap Heap Scan','Relation Name':'messages',
    'Actual Loops':1,'Actual Rows':1,'Recheck Cond':'normalized_body ~~ pattern','Filter':'organization_id = context',
    'Rows Removed by Filter':2001,'Rows Removed by Index Recheck':7,
    Plans:[{'Node Type':'Bitmap Index Scan','Index Name':index,'Index Cond':'normalized_body ~~ pattern',
      'Actual Rows':2009,'Actual Loops':1}]}}] as Parameters<typeof planFacts>[0];
test('plan evidence distinguishes executed PGroonga scans and reports filter/recheck counters',()=>{
  const sample = samplePlan();
  const facts = planFacts(sample);
  assert.equal(facts.searchIndex,true);
  assert.equal(facts.seqScanMessages,false);
  assert.deepEqual(facts.scans.map(s=>[s.rowsPerLoop,s.removedByFilterPerLoop,s.removedByRecheckPerLoop]),[[1,2001,7],[2009,0,0]]);
  sample[0].Plan.Plans![0]['Actual Loops'] = 0;
  assert.equal(planFacts(sample).searchIndex,false);
});
test('B1 timing plan capture explains the prepared page query and records raw evidence',()=>{
  const sample = samplePlan('search_channel_recent');
  let recorded: unknown;
  const facts = b1Plan(text=>{
    assert.equal(text,b1Begin('麒麟')+`PREPARE b1_search_page AS ${b1Query()};\n`+
      'EXPLAIN (ANALYZE, BUFFERS, SETTINGS, VERBOSE, FORMAT JSON) EXECUTE b1_search_page;\nCOMMIT;');
    return `${org(1)}|t\n${JSON.stringify(sample)}`;
  },'麒麟',explain=>{ recorded = explain; },{prepared:true});
  assert.deepEqual(recorded,sample);
  assert.equal(facts.searchIndex,false);
});
test('B1 forced denial requires the executed search_body plan',()=>{
  const probe = (index: string) => {
    const sample = samplePlan(index);
    let recorded: unknown;
    try {
      b1ForcedDenialPlan(text=>{
        assert.equal(text,b1Begin('denialprobe')+'SET LOCAL enable_seqscan=off;\n'+
          'EXPLAIN (ANALYZE, BUFFERS, SETTINGS, VERBOSE, FORMAT JSON) '+b1Query(member(1,1))+';\nCOMMIT;');
        return `${org(1)}|t\n${JSON.stringify(sample)}`;
      },explain=>{ recorded = explain; });
    } finally {
      assert.deepEqual(recorded,sample);
    }
  };
  assert.doesNotThrow(()=>probe('search_body'));
  assert.throws(()=>probe('search_channel_recent'),/forced denial plan did not use search_body/);
});

test('B1 context cleanup detects either setting persisting on its own',()=>{
  const execute = (leaked?: 'organization_id'|'search_query') => (sql: string) => {
    const session = new Map<string,string>();
    let local = new Map<string,string>();
    const get = (key: string) => local.get(key) ?? session.get(key);
    return sql.split(';').map(s=>s.trim()).filter(Boolean).flatMap(statement=>{
      if (statement.startsWith('BEGIN ')) return [];
      if (statement==='COMMIT') {
        if (leaked && local.has(leaked)) session.set(leaked,local.get(leaked)!);
        local = new Map();
        return [];
      }
      if (statement.startsWith('SELECT set_config')) {
        return [[...statement.matchAll(/set_config\('fukulow\.(organization_id|search_query)',\s*'([^']*)',\s*true\)/g)]
          .map(([,key,value])=>{
            local.set(key!,value!);
            return key==='search_query' ? 't' : value;
          }).join('|')];
      }
      assert.match(statement,/^SELECT count\(\*\) FROM public\.messages/);
      return [get('organization_id')===org(1) && get('search_query')==='denialprobe' && !statement.includes(org(2)) ? '7' : '0'];
    }).join('\n');
  };
  assert.doesNotThrow(()=>b1Cleanup(execute()));
  assert.throws(()=>b1Cleanup(execute('organization_id')),/context cleanup failed/);
  assert.throws(()=>b1Cleanup(execute('search_query')),/context cleanup failed/);
});

test('B1 timing fixture samples have paired IDs, counts and per-row byte lengths',t=>{
  const db = new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.function('md5',value=>createHash('md5').update(String(value)).digest('hex'));
  db.exec("ATTACH ':memory:' AS public; CREATE TABLE public.messages (organization_id TEXT,id TEXT,body TEXT);");
  const insert = db.prepare('INSERT INTO public.messages VALUES (?,?,?)');
  const few = [[org(1),'visible','開'],[org(2),'first','~~~'],[org(2),'second','~~~~~~']] as const;
  const many = [[org(1),'visible','開'],[org(2),'first','開'],[org(2),'second','開発']] as const;
  type Rows = readonly (readonly [string,string,string])[];
  const check = (manyRows: Rows, fewRows: Rows = few) => b1TimingFixture((arm,sql)=>{
    db.exec('DELETE FROM public.messages;');
    for (const row of arm==='few' ? fewRows : manyRows) insert.run(...row);
    const facts = db.prepare(sql).get();
    assert.ok(facts);
    return Object.values(facts).join('|');
  },1,2);
  assert.deepEqual(check([...many].reverse()),{visibleRows:1,foreignRows:2,fingerprint:check(many).fingerprint});
  assert.throws(()=>check(many.slice(0,2)),/fixture arms differ/);
  assert.throws(()=>check(many.slice(0,2),few.slice(0,2)),/fixture foreign row count/);
  assert.throws(()=>check([many[0],many[1],[org(2),'other','開発']]),/fixture arms differ/);
  assert.throws(()=>check([many[0],[org(2),'first','開発'],[org(2),'second','開']]),/fixture arms differ/);
  assert.throws(()=>check([[org(1),'visible','青'],many[1],many[2]]),/fixture arms differ/);
});
