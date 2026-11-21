import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const operations = ['private-grant','guest-grant','public','reactivate','regrant','join'] as const;
export type Operation = typeof operations[number];
export interface Point { topics:number; members:number; operation:Operation }
export function integers(value:string):number[] {
  const numbers=value.split(',').map(Number);
  if(!numbers.length || numbers.some(n=>!Number.isSafeInteger(n)||n<1) || new Set(numbers).size!==numbers.length) throw new Error('expected distinct positive integers');
  return numbers;
}
export function matrix(topics:number[],members:number[]):Point[] {
  integers(topics.join(',')); integers(members.join(','));
  return topics.flatMap(t=>operations.flatMap(operation=>(operation==='public'?members:[1]).map(m=>({topics:t,members:m,operation}))));
}
export function estimate(points:Point[],repeats:number,channels:number) {
  if(!Number.isSafeInteger(repeats)||repeats<3||!Number.isSafeInteger(channels)||channels<2) throw new Error('repeats >=3 and public channels >=2 required');
  const runs=points.length*repeats*2;
  const topicWrites=points.reduce((n,p)=>n+p.topics*p.members*(['join','reactivate'].includes(p.operation)?channels:1),0)*repeats;
  // Planning allowance, not a hardware-calibrated prediction: setup/cloning/read plans
  // plus 50k eager position inserts/s (pilot: ~100k rows in 2s), doubled for sampling/I/O variance.
  return {runs,topicWrites,minutes:Math.ceil((runs*5+topicWrites/50000)*2/60)};
}
export function equal(eager:unknown,lazy:unknown,label:string) {
  if(!isDeepStrictEqual(eager,lazy)) throw new Error(`eager/lazy mismatch: ${label}`);
}
// results.json keeps only this digest; the rows go to a gzipped file (they overflow one JSON string at 10k Topics × 1k Members).
export function oracleDigest(oracle:unknown) {
  const text=JSON.stringify(oracle);
  return {text,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};
}
export function percentile(values:number[],p:number) {
  if(!values.length) throw new Error('empty distribution');
  const a=[...values].sort((x,y)=>x-y); return a[Math.max(0,Math.ceil(a.length*p)-1)];
}
export interface Sample extends Point { variant:string; repeat:number; latencyMs:number; walBytes:number; rows:number; buffers:number; senderMs:number; senderBaselineMs:number; reads:ReadSample[] }
export interface ReadSample { stage:string; query:string; mode:string; ms:number; buffers:number }
const f=(v:number)=>v.toFixed(3);
export function summary(samples:Sample[],pilot:boolean,conditions:string):string {
  const lines=[`## Unread initialization #403 (${pilot?'PILOT — harness validation only':'measurement'})`,'',conditions,'',
    'Method: fresh migrated database clones per side/operation/repeat; alternating eager/lazy order. Non-owner NOBYPASSRLS app connections, transaction-local Organization context. Commit-inclusive server-clock latency; EXPLAIN ANALYZE BUFFERS/WAL for the mutation. Position writes are pg_stat_user_tables insert+update+delete deltas; WAL covers the concurrent sender too. Write buffers are pg_stat_database hit+read deltas including trigger queries, planning and concurrent sender; EXPLAIN root buffers are also retained, but omit trigger work. Read buffers use execution-root hit+read, excluding planning. Raw plans, lock/wait samples and per-table deltas are in results.json. Equality of Channel baselines, Unread/Mention counts and Topic projections asserted before reporting, before and after sparse Topic marks.','',
    '| Operation | Topics | Members | Eager median/p95 ms | Lazy median/p95 ms | Median improvement | Position writes E/L | WAL bytes E/L | Window buffers E/L | Sender added ms E/L |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for(const key of new Set(samples.map(s=>`${s.operation}/${s.topics}/${s.members}`))) {
    const [op,t,m]=key.split('/'); const group=samples.filter(s=>s.operation===op&&s.topics===Number(t)&&s.members===Number(m));
    const e=group.filter(s=>s.variant==='eager'),l=group.filter(s=>s.variant==='lazy'); if(!e.length||!l.length)throw new Error('unpaired result');
    const med=(a:Sample[],fn:(s:Sample)=>number)=>percentile(a.map(fn),.5);
    const latency=(a:Sample[])=>`${f(med(a,s=>s.latencyMs))}/${f(percentile(a.map(s=>s.latencyMs),.95))}`;
    lines.push(`| ${op} | ${t} | ${m} | ${latency(e)} | ${latency(l)} | ${f(100*(1-med(l,s=>s.latencyMs)/med(e,s=>s.latencyMs)))}% | ${med(e,s=>s.rows)}/${med(l,s=>s.rows)} | ${med(e,s=>s.walBytes)}/${med(l,s=>s.walBytes)} | ${med(e,s=>s.buffers)}/${med(l,s=>s.buffers)} | ${f(med(e,s=>s.senderMs-s.senderBaselineMs))}/${f(med(l,s=>s.senderMs-s.senderBaselineMs))} |`);
  }
  lines.push('','| Operation / Topics / Members | Read | Eager median/p95 ms | Lazy median/p95 ms | Median change | Buffers E/L |','|---|---|---:|---:|---:|---:|');
  for(const key of new Set(samples.map(s=>`${s.operation}/${s.topics}/${s.members}`))) {
  const point=samples.filter(s=>`${s.operation}/${s.topics}/${s.members}`===key);
  for(const stage of ['baseline','sparse'])for(const query of ['counts','projection'])for(const mode of ['custom','generic']) {
    const pick=(v:string)=>point.filter(s=>s.variant===v).flatMap(s=>s.reads.filter(r=>r.stage===stage&&r.query===query&&r.mode===mode));
    const e=pick('eager'),l=pick('lazy'); if(!e.length||!l.length)continue;
    const ms=(a:ReadSample[])=>`${f(percentile(a.map(r=>r.ms),.5))}/${f(percentile(a.map(r=>r.ms),.95))}`;
    lines.push(`| ${key} | ${stage}/${query}/${mode} | ${ms(e)} | ${ms(l)} | ${f(100*(percentile(l.map(r=>r.ms),.5)/percentile(e.map(r=>r.ms),.5)-1))}% | ${percentile(e.map(r=>r.buffers),.5)}/${percentile(l.map(r=>r.buffers),.5)} |`);
  }
  }
  lines.push('','Limits: DB-only trigger mutations and reader equivalents, no HTTP/auth/handler prelock/fan-out cost or production capacity claim. Sender uses the production #135 exclusive barrier and counter/Message write; an observed sender wait on a preheld grant shared barrier guarantees overlap, so added latency includes orchestration/sampling overhead. Lock sampling targets 10 ms between queries (plus transport); it can miss short waits. The uncontended sender baseline also commits; fixture restoration is outside the metric window. Projection uses the production core SQL with equivalent ordinary-Channel visibility; Mention payload decoration is omitted (Mention counts included). Warm caches, no OS cache eviction; default three repeats give a coarse p95 (maximum). WAL includes sender/background activity. Read comparisons are per matrix point; full matched plans are in JSON. Database buffer/WAL windows include instrumentation and the sender, so are supporting write-load evidence, not isolated per-query cost. Lazy overlay is measurement-only; adopting persistence changes requires separate approval.');
  return lines.join('\n')+'\n';
}
