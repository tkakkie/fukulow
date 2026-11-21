import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channel, member } from '../../search-engines/seed.ts';
import { earlyStop, planFacts, possibleLeak, ratios, scaledBytes, summarize } from './evidence.ts';
import type { Explain } from './evidence.ts';
import {
  decoy, foreignClasses, foreignRange, foreignSeed, normalizeSql, pairedArms, query, seedGram, visible,
} from './model.ts';

test('scope keys use Unicode scalars and retain literal metacharacters', () => {
  assert.equal(seedGram('開'), '開');
  assert.equal(seedGram('麒麟'), '麒麟');
  assert.equal(seedGram('🦉%_more'), '🦉%_');
  assert.equal(seedGram('%_\\suffix'), '%_\\');
  assert.equal(seedGram(''), '');
});

test('search SQL scopes the key to visible Channels and escapes the LIKE recheck', () => {
  const d3 = query('d3', "x%_\\'z", 3);
  assert.ok(d3.includes(visible(3)));
  assert.ok(d3.includes(member(1, 3)));
  assert.ok(d3.includes("scope_term = v.id::text || ':' || 'x%_'"));
  assert.ok(d3.includes("LIKE '%x\\%\\_\\\\''z%'"));
  assert.ok(d3.includes('m.channel_id = v.id'));
  assert.ok(d3.endsWith('ORDER BY hit.created_at DESC, hit.id DESC LIMIT 20'));
  assert.match(query('d4','麒麟'), /ORDER BY m.created_at DESC, m.id DESC LIMIT 20/);
  assert.doesNotMatch(query('d4','麒麟',2,false), /LIMIT/);
  const d3r = query('d3r', "x%_\\'z", 3);
  assert.ok(d3r.includes(visible(3)));
  assert.match(d3r, /m\.channel_id = v\.id[\s\S]*LIKE .*\n[\s\S]*t\.channel_id = v\.id AND t\.term = 'x%_'[\s\S]*ORDER BY t\.created_at DESC, t\.message_id DESC LIMIT 20/);
  assert.ok(d3r.endsWith('ORDER BY hit.created_at DESC, hit.id DESC LIMIT 20'));
  assert.doesNotMatch(query('d3r','麒麟',2,false), /LIMIT/);
  // Replace callbacks must preserve the dollar patterns recognized by String.replace.
  assert.ok(query('d3', '$&').includes("|| '$&'"));
  assert.match(normalizeSql('  か\u3099  '), /'か\u3099'/);
});

test('timing arms preserve marker lengths and alternate order', () => {
  assert.deepEqual(pairedArms(0,0), ['few','many']);
  assert.deepEqual(pairedArms(1,0), ['many','few']);
  assert.deepEqual(pairedArms(0,1), ['many','few']);
  for (const target of foreignClasses) {
    assert.ok(foreignSeed(target,'few').includes(channel(target.org,target.channel)));
    assert.equal(
      foreignSeed(target,'many').replace('n<=1000','n<=1'),
      foreignSeed(target,'few'),
    );
    assert.match(foreignRange(target), /id BETWEEN \d+ AND \d+/);
    const other = decoy(target.key);
    assert.equal(Buffer.byteLength(other), Buffer.byteLength(target.key));
    assert.equal(grams(other), grams(target.key));
    assert.ok(!other.includes(seedGram(target.key)));
  }
});

const grams = (text: string) => new Set([1,2,3].flatMap(w =>
  [...text].slice(0, text.length - w + 1).map((_, i) => text.slice(i, i + w)))).size;

test('plan evidence distinguishes keyed scans, sequential scans and sort input', () => {
  const index = {'Node Type':'Index Scan','Index Name':'search_terms_exact',
    'Index Cond':"(t.scope_term = ((v.id)::text || ':開発'::text))",'Actual Rows':80,'Actual Loops':5};
  const plan = planFacts([{Plan:{'Node Type':'Sort','Sort Method':'top-N heapsort',
    'Actual Rows':20,'Actual Loops':1,Plans:[index]},'Execution Time':4}]);
  assert.ok(plan.searchTermsExactKey);
  assert.equal(plan.searchTermsSequential,false);
  assert.equal(plan.scansAndSorts[0]?.sortInputRowsPerLoop,80);
  assert.equal(planFacts([{Plan:{...index,'Actual Loops':0},'Execution Time':0}]).searchTermsExactKey,false);
});

test('statistics retain sample counts and scale size linearly', () => {
  const few = summarize([1,2,3,4,5]);
  assert.deepEqual(few,{n:5,p50:3,p95:5});
  assert.deepEqual(ratios(few,summarize([2,4,6,8,10])),{p50:2,p95:2});
  assert.deepEqual(scaledBytes(150,15000),{bytes:150,per10k:100,linearAt1M:10000});
  assert.throws(()=>summarize([]),/Invalid samples/);
});

test('timing flags require both percentiles to cross the same fixed boundary', () => {
  for (const p of [1.10,0.91]) assert.ok(possibleLeak({p50:p,p95:p}));
  for (const [p50,p95] of [[1.09,1.2],[0.9,0.92],[1.11,0.9],[null,2]] as const) {
    assert.equal(possibleLeak({p50,p95}),false);
  }
});

test('early stop requires an ordered scope walk and rejects a node consuming all visible hits', () => {
  type Plan = Explain[0]['Plan'];
  const node = (type: string, rows: number, loops: number, children: Plan[] = []): Plan =>
    ({'Node Type':type,'Actual Rows':rows,'Actual Loops':loops,Plans:children});
  const explain = (loops: number, mergeRows = 20 * loops): Explain => {
    const terms = {...node('Index Only Scan',25,loops),'Index Name':'search_terms_recent_key',
      'Scan Direction':'Forward','Index Cond':'(organization_id = org AND channel_id = v.id AND term = word)'};
    const messages = {...node('Index Scan',0.8,25 * loops),'Index Name':'messages_pkey',
      Filter:'(m.normalized_body ~~ pattern)','Rows Removed by Filter':0.2};
    const limit = node('Limit',20,loops,[node('Nested Loop',20,loops,[terms,messages])]);
    const merge = node('Nested Loop',mergeRows,1,[node('CTE Scan',loops,1),limit]);
    return [{Plan:node('Limit',20,1,[node('Sort',20,1,[merge])]),'Execution Time':1}];
  };
  const scopes = Object.fromEntries(['a','b','c','d','e'].map(scope=>[scope,explain(1)]));
  assert.ok(earlyStop(explain(5),scopes,500).pass);
  assert.equal(earlyStop(explain(5,101),scopes,500).pass,false);
  assert.equal(earlyStop(explain(5),scopes,125).pass,false);
  scopes.a = [{Plan:node('Seq Scan',200,1),'Execution Time':1}];
  assert.equal(earlyStop(explain(5),scopes,500).pass,false);
});
