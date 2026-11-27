// Dedicated-hardware fixture only: 50M 1-KiB Messages. Never defaults to running.
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { outsideCheckout } from './dms-workload.ts';
import { fixturePairs, heldCohorts, type MixedScenario } from './dms-formal-scenarios.ts';
import { seedFailure, type SeedStop } from './dms-formal-seed-diagnostic.ts';

const BATCH_FACTOR = 3;
const ORG_FACTOR = 2;
// A 5 s floor keeps brief smoke-fixture batches from tripping on scheduler or Docker startup jitter.
const MIN_BATCH_MS = 5_000;

export function messageBatchBaselineMs(batchTimes: readonly number[]): number | undefined {
  const sorted = batchTimes.slice(1).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return (sorted[middle]! + sorted[Math.floor((sorted.length - 1) / 2)]!) / 2;
}

export function checkMessageBatch(organization: number, batchIndex: number, durationMs: number, baselineMs: number | undefined, onStop?: (limitMs: number) => void) {
  if (organization === 0 || batchIndex === 0 || baselineMs === undefined || durationMs < MIN_BATCH_MS) return;
  const limitMs = BATCH_FACTOR * baselineMs;
  if (durationMs > limitMs) {
    onStop?.(limitMs);
    throw new Error(`Organization ${organization} Message batch ${batchIndex} took ${durationMs} ms (limit ${limitMs} ms)`);
  }
}

export function checkOrganization(organization: number, lastBatchIndex: number, durationMs: number, baselineMs: number | undefined, onStop?: (limitMs: number) => void) {
  if (organization === 0 || baselineMs === undefined) return;
  const limitMs = ORG_FACTOR * baselineMs;
  if (durationMs > limitMs) {
    onStop?.(limitMs);
    throw new Error(`Organization ${organization} total through Message batch ${lastBatchIndex} and final setup took ${durationMs} ms (limit ${limitMs} ms)`);
  }
}

// The start row also names the backend PID, which joins the session's server-reported statement durations
// (log_duration, set for the diagnostic batch session only) in the DB log to this batch.
export const dbClockSql = (label: 'db-start' | 'db-end') =>
  `SELECT '${label}', round(extract(epoch FROM clock_timestamp()) * 1000, 3)${label === 'db-start' ? ', pg_backend_pid()' : ''};`;
export const diagnosticSessionSql = 'SET log_duration = on;';
// The server clock span between the two clock rows of one psql session. It covers PostgreSQL execution and also any
// psql client time between the statements (descheduling, pipe I/O), so it is an upper bound on PostgreSQL time.
export type DbBatchClock = { dbClockStartMs: number; dbClockEndMs: number; dbClockSpanMs: number; dbBackendPid: number } | { dbClock: 'missing' };

// Reads the two clock rows from psql -qAt output; anything else on stdout is ignored.
export function dbBatchClock(stdout: Buffer | string | null | undefined): DbBatchClock {
  const text = stdout?.toString() ?? '';
  const start = /^db-start\|(\d+(?:\.\d+)?)\|(\d+)$/m.exec(text), end = /^db-end\|(\d+(?:\.\d+)?)$/m.exec(text);
  const dbClockStartMs = Number(start?.[1]), dbClockEndMs = Number(end?.[1]), dbBackendPid = Number(start?.[2]);
  if (!start || !end || dbClockEndMs < dbClockStartMs) return { dbClock: 'missing' };
  return { dbClockStartMs, dbClockEndMs, dbClockSpanMs: Math.round((dbClockEndMs - dbClockStartMs) * 1000) / 1000, dbBackendPid };
}

// Message batches per Organization: every batch when unset or empty, else a positive integer up to that count.
export function seedBatchLimit(value: string | undefined, pairCount: number) {
  const all = Math.ceil(pairCount / 250);
  if (value === undefined || value === '') return all;
  const batches = Number(value);
  if (!/^[1-9]\d*$/.test(value) || batches > all) throw new Error(`DM_FORMAL_SEED_BATCHES must be an integer from 1 to ${all}`);
  return batches;
}

export function seed(diagnostic = false) {
  if (process.env.DM_FORMAL_SEED !== '1') throw new Error('Set DM_FORMAL_SEED=1 only on the dedicated disposable DB host (50M Messages)');
  const output = resolve(process.env.DM_FORMAL_OUT || '');
  if (!process.env.DM_FORMAL_OUT || !outsideCheckout(output, resolve('.'))) throw new Error('DM_FORMAL_OUT must be outside checkout');
  const container = process.env.DM_DB_CONTAINER;
  if (!container) throw new Error('DM_DB_CONTAINER required');
  mkdirSync(output, { recursive: true });
  const trace = diagnostic ? seedFailure(Date.now(), 0) : undefined;
  try {
    seedFixture(output, container, trace);
  } catch (error) {
    if (trace) {
      if (trace.rule === 'seed-failure') {
        trace.endedAtMs = Date.now();
        trace.durationMs = trace.endedAtMs - trace.startedAtMs;
      }
      const path = `${output}/seed-stop.json`;
      writeFileSync(path + '.tmp', JSON.stringify(trace), { mode: 0o600 });
      renameSync(path + '.tmp', path);
    }
    throw error;
  }
}

function seedFixture(output: string, container: string, trace?: SeedStop) {
  const uuid = (label: string) => { const s = createHash('md5').update(`dm151-formal:${label}`).digest('hex'); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`; };
  const sql = (input: string) => execFileSync('docker', ['exec','-i',container,'psql','-X','-U','fukulow','-d','fukulow','-v','ON_ERROR_STOP=1'], { input, stdio: ['pipe','ignore','inherit'], timeout: 3_600_000, maxBuffer: 64*1024*1024 });
  // Chosen once, outside every timed region: formal seeds call the origin/main `sql` itself for Message batches.
  // The diagnostic adds log_duration and the server clock rows in the same psql call and keeps the raw stdout; it is
  // parsed after the batch timer stops.
  let clockStdout: Buffer | undefined;
  const batchSql = trace ? (input: string) => { clockStdout = execFileSync('docker', ['exec','-i',container,'psql','-X','-U','fukulow','-d','fukulow','-v','ON_ERROR_STOP=1','-q','-A','-t'], { input: `${diagnosticSessionSql}\n${dbClockSql('db-start')}\n${input}\n${dbClockSql('db-end')}`, stdio: ['pipe','pipe','inherit'], timeout: 3_600_000, maxBuffer: 64*1024*1024 }); } : sql;
  const scenario=process.env.DM_FORMAL_SCENARIO || 'main';
  if(scenario!=='main' && scenario!=='held200')throw new Error('Seed requires main or held200 scenario');
  const {historical:pairs,supplemental:extraPairs}=fixturePairs(scenario);
  // The seed diagnostic rehearsal (#920) seeds Messages for the first DM_FORMAL_SEED_BATCHES batches only; unset, every
  // historical pair gets its Messages, as before.
  const batchPairs = pairs.slice(0, seedBatchLimit(process.env.DM_FORMAL_SEED_BATCHES, pairs.length) * 250);
  const smoke = process.env.DM_FORMAL_SMOKE === '1';
  const history = smoke ? 1 : 100;
  const timingPath = `${output}/seed-timing.jsonl`;
  const recordTiming = (row: { organization: number; durationMs: number; startedAtMs?: number; endedAtMs?: number } & ({ kind: 'batch'; batchIndex: number } & (DbBatchClock & { recorderMs: number } | Record<never, never>) | { kind: 'organization' })) =>
    appendFileSync(timingPath, JSON.stringify(row) + '\n', { mode: 0o600, flush: true });
  // Diagnostic only, after the batch timer: recorderMs is the parse cost this instrumentation adds per batch.
  const diagnosticClock = () => {
    const parseStart = performance.now();
    const clock = dbBatchClock(clockStdout);
    clockStdout = undefined;
    return { ...clock, recorderMs: Math.round((performance.now() - parseStart) * 1000) / 1000 };
  };
  const firstOrganizationBatches: number[] = [];
  let batchBaselineMs: number | undefined;
  let organizationBaselineMs: number | undefined;
  for (let o = 0; o < (Number(process.env.DM_FORMAL_SEED_ORGS || 0) || (smoke ? 1 : 10)); o++) {
    const organizationStart = performance.now();
    const organizationStartedAtMs = trace ? Date.now() : 0;
    if (trace) Object.assign(trace, { organization: o, batchIndex: null, baselineMs: organizationBaselineMs ?? null, startedAtMs: organizationStartedAtMs });
    const org = uuid(`org:${o}`), ordinary = uuid(`ordinary:${o}`), topic = uuid(`topic:${o}`);
    const channelId = (a: number, b: number) => uuid(`pair:${o}:${Math.min(a,b)}:${Math.max(a,b)}`);
    const members = Array.from({ length: 1000 }, (_, i) => ({ id: uuid(`member:${o}:${i}`), token: randomBytes(32).toString('hex'), channel: channelId(i,i^1), peer: uuid(`member:${o}:${i^1}`), extraToken: i%10 === 0 ? randomBytes(32).toString('hex') : undefined }));
    sql(`INSERT INTO organizations(organization_id,name) VALUES('${org}','Formal ${o}'); INSERT INTO channels(organization_id,id,name,visibility) VALUES('${org}','${ordinary}','Ordinary','public');`);
    for (let start = 0; start < 1000; start += 100) {
      const statements = ['BEGIN;'];
      for (let i = start; i < start+100; i++) {
        const m = members[i];
        statements.push(`INSERT INTO accounts(id,email,password_hash) VALUES('${m.id}','formal-${o}-${i}@example.invalid','unused'); INSERT INTO users(organization_id,id,account_id,name,role) VALUES('${org}','${m.id}','${m.id}','Member ${i}','${i >= 900 ? 'guest' : 'member'}');`);
        for (const token of [m.token,m.extraToken].filter((v): v is string => !!v)) statements.push(`INSERT INTO account_sessions(account_id,token_hash) VALUES('${m.id}',decode('${createHash('sha256').update(token).digest('hex')}','hex'));`);
      }
      sql(statements.join('\n')+'\nCOMMIT;');
    }
    // Prepare a current revision with some genuinely historical grants for the
    // timed renewal pool. Watched reciprocal pairs always retain current grants.
    sql(`UPDATE users SET deactivated_at=clock_timestamp() WHERE organization_id='${org}'; UPDATE users SET deactivated_at=NULL WHERE organization_id='${org}';`);
    const allPairs=[...pairs,...extraPairs];
    for (let start = 0; start < allPairs.length; start += 250) {
      const batch = allPairs.slice(start,start+250), ids = batch.map(([a,b]) => channelId(a,b));
      sql('BEGIN;\n'+batch.map(([a,b]) => `INSERT INTO channels(organization_id,id,kind,lower_member_id,higher_member_id,created_at) VALUES('${org}','${channelId(a,b)}','dm',least('${members[a].id}'::uuid,'${members[b].id}'::uuid),greatest('${members[a].id}'::uuid,'${members[b].id}'::uuid),'2026-01-01');`).join('\n')+`\nINSERT INTO channel_members(organization_id,channel_id,member_id,membership_revision) SELECT organization_id,id,m,1 FROM channels CROSS JOIN LATERAL unnest(ARRAY[lower_member_id,higher_member_id]) m WHERE organization_id='${org}' AND id=ANY(ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}]) ORDER BY m,id; COMMIT;`);
    }
    const renewals = pairs.filter(([a,b]) => a < 900 && (a^1) !== b).slice(0,10000).map(([a,b]) => ({ caller: a, peer: b, channel: channelId(a,b) }));
    for (let start = 0; start < renewals.length; start += 100) sql('BEGIN;\n'+renewals.slice(start,start+100).map(r => `UPDATE channel_members SET membership_revision=0 WHERE organization_id='${org}' AND channel_id='${r.channel}' AND member_id='${members[r.peer].id}';`).join('\n')+'\nCOMMIT;');
    // Each newly inserted Organization is absent from stale planner statistics.
    // Refresh before the cleanup join; provisioning is outside every timed arm.
    sql('ANALYZE channel_members; ANALYZE channel_read_positions;');
    sql(`DELETE FROM channel_read_positions p USING channel_members cm WHERE cm.organization_id='${org}' AND cm.membership_revision=0 AND p.organization_id=cm.organization_id AND p.channel_id=cm.channel_id AND p.member_id=cm.member_id;
INSERT INTO channel_members(organization_id,channel_id,member_id,membership_revision) SELECT '${org}','${ordinary}',id,1 FROM users WHERE organization_id='${org}' AND (role='guest' OR id='${members[0].id}');
INSERT INTO dm_discovery_counters(organization_id,member_id,membership_revision,position) SELECT '${org}',id,1,10300 FROM users WHERE organization_id='${org}';
INSERT INTO dm_discovery(organization_id,member_id,membership_revision,channel_id,grant_id,birth_position,latest_position) SELECT organization_id,member_id,1,channel_id,grant_id,row_number() OVER(PARTITION BY member_id ORDER BY channel_id),10000+row_number() OVER(PARTITION BY member_id ORDER BY channel_id) FROM channel_members WHERE organization_id='${org}' AND dm_created_at IS NOT NULL AND membership_revision=1;
INSERT INTO channel_message_sequences(organization_id,channel_id,seq) SELECT '${org}',id,${history} FROM channels WHERE organization_id='${org}' AND id=ANY(ARRAY[${pairs.map(([a,b])=>"'"+channelId(a,b)+"'::uuid").join(',')}]);`);
    for (let start = 0; start < batchPairs.length; start += 250) {
      const batchStart = performance.now();
      const batchIndex = start / 250;
      const startedAtMs = trace ? Date.now() : 0;
      if (trace) Object.assign(trace, { batchIndex, baselineMs: batchBaselineMs ?? null, startedAtMs });
      const ids = batchPairs.slice(start,start+250).map(([a,b]) => channelId(a,b));
      batchSql(`INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body) SELECT '${org}',gen_random_uuid(),c.id,n,CASE WHEN n%2=0 THEN c.lower_member_id ELSE c.higher_member_id END,gen_random_uuid(),repeat('x',1024) FROM channels c CROSS JOIN generate_series(1,${history}) n WHERE c.organization_id='${org}' AND c.id=ANY(ARRAY[${ids.map(id => `'${id}'::uuid`).join(',')}]);`);
      const durationMs = performance.now() - batchStart;
      const endedAtMs = trace ? Date.now() : 0;
      recordTiming({ kind: 'batch', organization: o, batchIndex, durationMs, ...(trace ? { startedAtMs, endedAtMs, ...diagnosticClock() } : {}) });
      if (o === 0) firstOrganizationBatches.push(durationMs);
      checkMessageBatch(o, batchIndex, durationMs, batchBaselineMs, trace && (limitMs => {
        Object.assign(trace, { rule: 'message-batch', durationMs, limitMs, endedAtMs });
      }));
      if (trace) Object.assign(trace, { batchIndex: null, baselineMs: organizationBaselineMs ?? null, startedAtMs: organizationStartedAtMs });
      // Keep the pre-#620 ANALYZE command in the seed transcript.
      if (start === 0) sql('ANALYZE messages, channel_log;');
    }
    sql(`INSERT INTO channel_message_sequences VALUES('${org}','${ordinary}',1); INSERT INTO topics(organization_id,channel_id,id,name,first_seq,last_seq,message_count) VALUES('${org}','${ordinary}','${topic}','Topic',1,1,1); INSERT INTO messages(organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) VALUES('${org}',gen_random_uuid(),'${ordinary}',1,'${members[0].id}',gen_random_uuid(),'seed','${topic}');`);
    writeFileSync(`${output}/org-${o}.json`, JSON.stringify({ organization: org, channel: ordinary, topic, members, renewals, supplementalEmptyPairs:extraPairs.length, scenario, heldAssignment:heldCohorts(scenario as MixedScenario), fixture:{pairs:pairs.length+extraPairs.length,historicalPairs:pairs.length,messages:batchPairs.length*history} }), { mode: 0o600 });
    const durationMs = performance.now() - organizationStart;
    const endedAtMs = trace ? Date.now() : 0;
    recordTiming({ kind: 'organization', organization: o, durationMs, ...(trace ? { startedAtMs: organizationStartedAtMs, endedAtMs } : {}) });
    console.log(`${smoke ? 'SMOKE ONLY' : 'Formal'} scenario=${scenario} Organization ${o}: 1,000 Members (100 Guests), 1,100 Sessions, ${pairs.length+extraPairs.length} DMs (${extraPairs.length} supplemental empty pairs), ${batchPairs.length*history} Messages; current revision 1, ${2*(pairs.length+extraPairs.length)-10000} usable + 10,000 old-revision grants, read_seq 0, alternating senders, zero Mentions; 10,000 prepared renewals; seeded in ${durationMs.toFixed(0)} ms`);
    const lastBatchIndex = Math.ceil(batchPairs.length / 250) - 1;
    checkOrganization(o, lastBatchIndex, durationMs, organizationBaselineMs, trace && (limitMs => {
      Object.assign(trace, { rule: 'organization-total', batchIndex: lastBatchIndex, durationMs, limitMs, endedAtMs });
    }));
    if (o === 0) {
      batchBaselineMs = messageBatchBaselineMs(firstOrganizationBatches);
      organizationBaselineMs = durationMs;
    }
  }
  if (trace) Object.assign(trace, seedFailure(Date.now(), 0));
  sql('VACUUM(ANALYZE);');
}

if (process.argv[1] === import.meta.filename) seed(process.argv[2] === '--seed-diagnostic');
