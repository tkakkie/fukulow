import { createReadStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { percentile } from './dms-workload.ts';
import { offeredBucketMs, type OfferedBucket, type OfferedRound } from './dms-formal-concurrency.ts';

const directory = resolve(process.argv[2] || process.env.LOAD_RESULT_DIR || '');
const shards = Number(process.env.DM_SHARDS || 4);
const from = Number(process.env.DM_WINDOW_FROM || 0), to = Number(process.env.DM_WINDOW_TO || Number.MAX_SAFE_INTEGER);
const offeredBuckets=new Map<number,OfferedBucket>();
const offeredRounds=new Map<string,OfferedRound>();
const bucketAt=(at:number)=>{
  const start=from+Math.floor((at-from)/offeredBucketMs)*offeredBucketMs;
  if(!offeredBuckets.has(start))offeredBuckets.set(start,{from:start,to:Math.min(to,start+offeredBucketMs),offered:{},rounds:[]});
  return offeredBuckets.get(start)!;
};
const mix:Record<string,number>={};
const mixMembers=new Map<string,Set<string>>();
const closeCodes: Record<string, number> = {};
const values = new Map<string, number[]>(), counters: Record<string, number> = {}, connections: { at: number; shard: number; value: number }[] = [];
for (let shard = 0; shard < shards; shard++) {
  const path = `${directory}/shard-${shard}/metrics.json`;
  if (!existsSync(path)) continue;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    let point;
    try { point = JSON.parse(line); } catch { throw new Error(`Incomplete metric line in shard ${shard}`); }
    if (point.type !== 'Point') continue;
    const { metric, data } = point;
    if(typeof metric!=='string' || !data || !Number.isFinite(data.value) || !Number.isFinite(Date.parse(data.time)) || !data.tags || typeof data.tags!=='object')throw new Error(`Malformed metric point in shard ${shard}`);
    if (metric === 'dm_connections') connections.push({ at: Date.parse(data.time), shard, value: data.value });
    const sentAt = data.tags.sentBucket || data.tags.sent;
    const sampleAt = sentAt && ['dm_expected_peer','dm_received_peer','dm_receipt_ms'].includes(metric) ? Number(sentAt) : Date.parse(data.time);
    if(metric==='dm_o5_round_start_ms') {
      const at=data.value,member=Number(data.tags.member),retained=Number(data.tags.retained);
      if(at>=from && at<to && Number.isSafeInteger(at) && Number.isSafeInteger(member) && Number.isSafeInteger(retained)) {
        const key=shard+':'+member+':'+at;
        if(data.tags.lane==='start') {
          const round={member,retained,at,lanes:[]};offeredRounds.set(key,round);bucketAt(at).rounds.push(round);
        } else offeredRounds.get(key)?.lanes.push(data.tags.lane);
      }
    }
    if (sampleAt < from || sampleAt >= to) continue;
    if(metric==='dm_offered') {const b=bucketAt(sampleAt);b.offered[data.tags.shape]=(b.offered[data.tags.shape]||0)+data.value;}
    if(metric==='dm_mix') {const key=data.tags.retained+':'+data.tags.lane;mix[key]=(mix[key]||0)+data.value;if(data.value>0 && data.tags.member!==undefined){if(!mixMembers.has(key))mixMembers.set(key,new Set());mixMembers.get(key)!.add(data.tags.member);}}
    if(metric==='dm_offered') {const key=metric+':'+data.tags.shape;counters[key]=(counters[key]||0)+data.value;}
    if (metric === 'dm_errors' && data.tags.shape === 'close') closeCodes[data.tags.code || 'unknown'] = (closeCodes[data.tags.code || 'unknown'] || 0) + data.value;
    if (metric === 'dm_errors' || metric === 'dropped_iterations') { const key = metric+':'+(data.tags.shape || data.tags.scenario || '')+':'+(data.tags.status || ''); counters[key] = (counters[key] || 0)+data.value; }
    else if (['dm_accepted','dm_ready','dm_subscribed','dm_expected_peer','dm_received_peer','dm_duplicate_frames','dm_pending_rounds'].includes(metric)) counters[metric] = (counters[metric] || 0)+data.value;
    if (['dm_latency_ms','dm_receipt_ms','dm_round_ms','dm_round_attempts'].includes(metric)) {
      const key = metric+(data.tags.shape ? ':'+data.tags.shape : '')+(metric === 'dm_round_ms' && data.tags.attempts ? ':attempts='+data.tags.attempts : '');
      if (!values.has(key)) values.set(key, []);
      values.get(key)!.push(data.value);
      if(metric==='dm_round_ms' && data.tags.attempts) {
        const aggregate=metric+(data.tags.shape?':'+data.tags.shape:'');
        if(!values.has(aggregate))values.set(aggregate,[]);
        values.get(aggregate)!.push(data.value);
      }
    }
  }
}
const live = Array<number>(shards).fill(0); let peak = 0, fullSince: number | undefined, fullIntervals: { start: number; end: number }[] = [];
connections.sort((a,b) => a.at-b.at);
const target = Number(process.env.DM_SOCKETS || 10000);
for (const e of connections) {
  live[e.shard] = e.value;
  const total = live.reduce((a,b) => a+b,0); peak = Math.max(peak,total);
  if (total === target && fullSince === undefined) fullSince = e.at;
  if (total < target && fullSince !== undefined) { fullIntervals.push({ start: fullSince, end: e.at }); fullSince = undefined; }
}
const latencies = Object.fromEntries([...values].map(([key, v]) => [key, { samples: v.length, p50: percentile(v,.5), p95: percentile(v,.95), p99: percentile(v,.99), max: v.reduce((a,b) => Math.max(a,b), -Infinity) }]));
const pool: number[] = [], active: number[] = [];
let poolErrors = 0;
if (existsSync(`${directory}/app.log`)) for (const line of readFileSync(`${directory}/app.log`, 'utf8').split('\n')) {
  const at = Date.parse(line.split(' ')[0]);
  if (Number.isFinite(at) && (at < from || at >= to)) continue;
  const lifetime = /event=measure_hold op=\S+ wait_us=(\d+) hold_us=\d+ active=(\d+) waiting=\d+ http=\d+ acquired=(true|false)/.exec(line);
  if (lifetime) { if (lifetime[3] === 'false') poolErrors++; else { pool.push(Number(lifetime[1])/1000); active.push(Number(lifetime[2])); } continue; }
  const match = /event=measure_pool us=(\d+) active=(\d+) size=\d+ error=(true|false)/.exec(line);
  if (!match) continue;
  if (match[3] === 'true') poolErrors++; else { pool.push(Number(match[1])/1000); active.push(Number(match[2])); }
}
const resources: Record<string, { cpu: number[]; memory: string[] }> = {};
const rss: number[] = [], dbRss: number[] = [], dbPss: number[] = [], lockSamples: number[] = [];
if (existsSync(`${directory}/resources.json`)) for (const sample of JSON.parse(readFileSync(`${directory}/resources.json`, 'utf8'))) {
  if (sample.at < from || sample.at >= to) continue;
  for (const row of sample.stats) {
    const name = /-app-1$/.test(row.Name) ? 'app' : /-db-1$/.test(row.Name) ? 'db' : row.Name;
    resources[name] ||= { cpu: [], memory: [] }; resources[name].cpu.push(parseFloat(row.CPUPerc)/100); resources[name].memory.push(row.MemUsage);
  }
  const match = /VmRSS:\s+(\d+)/.exec(sample.rss); if (match) rss.push(Number(match[1]));
  if (sample.dbRssKiB) dbRss.push(sample.dbRssKiB); if (sample.dbPssKiB) dbPss.push(sample.dbPssKiB);
  if (sample.activity) lockSamples.push(Number(JSON.parse(sample.activity).locks));
}
const report = { scenario: process.env.DM_FORMAL_SCENARIO || 'main', label: process.env.DM_FORMAL_MODE === 'smoke' ? 'NON-ACCEPTANCE' : process.env.DM_FORMAL_MODE === 'formal' ? 'FORMAL' : undefined, window: { from,to }, peakConnections: peak, offeredWork:{bucketMs:offeredBucketMs,coverage:.99,buckets:[...offeredBuckets.values()].sort((a,b)=>a.from-b.from)}, mix, mixMembers:Object.fromEntries([...mixMembers].map(([key,ids])=>[key,ids.size])), fullIntervals, counters, closeCodes, peerMissing: counters.dm_expected_peer === undefined ? null : counters.dm_expected_peer-(counters.dm_received_peer || 0), latencies,
  pool: { samples: pool.length, p95: percentile(pool,.95), p99: percentile(pool,.99), errors: poolErrors, activeP95: percentile(active,.95), activePeak: active.length ? Math.max(...active) : null },
  resources: Object.fromEntries(Object.entries(resources).map(([k,v]) => [k, { samples: v.cpu.length, cpuMean: v.cpu.reduce((a,b) => a+b,0)/v.cpu.length, cpuP99: percentile(v.cpu,.99), memoryLast: v.memory.at(-1) }])),
  memoryKiB: { appRssPeak: percentile(rss,1), dbRssPeak: percentile(dbRss,1), dbPssPeak: percentile(dbPss,1) }, lockSamplePeak: percentile(lockSamples,1) };
writeFileSync(`${directory}/combined.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
