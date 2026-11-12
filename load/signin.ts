import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { workload, type Config } from './signin-workload.ts';
import { resourceSample, summarize, type Sample } from './signin-summary.ts';
import type { NativeSessionResponse, SetupRequest } from '../web/src/api-schema.d.ts';
const exec = promisify(execFile);
function integer(key: string, fallback: number, max = 1_000_000) {
  const value = process.env[key] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new Error(`Invalid ${key}`);
  return Number(value);
}
function allocatorSetting(key: string) {
  const value = process.env[key];
  if (value !== undefined && (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}
const allocator = { MALLOC_MMAP_THRESHOLD_:allocatorSetting('LOAD_MALLOC_MMAP_THRESHOLD'),
  MALLOC_ARENA_MAX:allocatorSetting('LOAD_MALLOC_ARENA_MAX') };
const idleMs = 12000;
const config: Config = { concurrency: integer('SIGNIN_CONCURRENCY', 64), seconds: integer('SIGNIN_SECONDS', 60),
  rate: integer('SIGNIN_RATE', 100), readRate: integer('SIGNIN_READ_RATE', 2), accounts: integer('SIGNIN_ACCOUNTS', 1000),
  ipPool: integer('SIGNIN_IP_POOL', 10000, 16_777_216), correctEvery: integer('SIGNIN_CORRECT_EVERY', 10),
  timeoutSeconds: integer('SIGNIN_TIMEOUT_SECONDS', 45) };
if (config.correctEvery < 3) throw new Error('SIGNIN_CORRECT_EVERY must be >= 3 to include all workload kinds');
const project = `fukulow-signin-${Date.now()}-${randomUUID().slice(0,8)}`;
const output = resolve(process.env.LOAD_RESULT_DIR || `${tmpdir()}/${project}`);
const rel = relative(resolve('.'), output);
if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('LOAD_RESULT_DIR must be outside the checkout');
const port = integer('LOAD_PORT', 18096, 65535);
if (port < 1024 || [8080,55432].includes(port)) throw new Error('Use a non-default unprivileged LOAD_PORT');
if (process.env.SERVER_REF && process.env.LOAD_APP_IMAGE) throw new Error('Choose SERVER_REF or LOAD_APP_IMAGE');
mkdirSync(output, { recursive:true });
const scratch = mkdtempSync(`${tmpdir()}/${project}-`);
const password = randomUUID();
const env = { ...process.env, LOAD_PROJECT:project, LOAD_PORT:String(port), LOAD_DB_PASSWORD:randomUUID(),
  LOAD_APP_PASSWORD:randomUUID(), LOAD_SETUP_TOKEN:randomUUID(), LOAD_APP_IMAGE:process.env.LOAD_APP_IMAGE || `${project}-app`,
  LOAD_SERVER_SOURCE:resolve('.') };
const override = `${scratch}/compose.json`;
// Only this disposable stack trusts synthetic client IPs, allowing password admission
// to be exercised without one generator IP exhausting the throttle after 20 failures.
writeFileSync(override, JSON.stringify({services:{app:{environment:{
  FUKULOW_CLIENT_IP_HEADER:'x-load-client-ip', FUKULOW_TRUSTED_PROXIES:'0.0.0.0/0,::/0',
  ...allocator }}}}));
const compose = ['compose','-p',project,'-f',resolve('load/compose.yml'),'-f',override];
const command = (file: string, args: string[], input?: string) => execFileSync(file,args,
  {env, input, encoding:'utf8', stdio:['pipe','pipe','pipe'], maxBuffer:32*1024*1024}).trim();
const docker = (...args: string[]) => command('docker',args);
const sql = (query: string) => command('docker',[...compose,'exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','fukulow','-d','fukulow','-At'],query);
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on('SIGINT',interrupt); process.on('SIGTERM',interrupt);
const samples: Sample[] = [];
let postIdleSample: Sample | null = null;
const samplingErrors: string[] = [];
let timer: ReturnType<typeof setInterval> | undefined;
let sampling: Promise<void> | undefined;
let result: Awaited<ReturnType<typeof workload>> | undefined;
let failed = false;
let phase = 'source';
let serverCommit: string | null = null;
const cleanupErrors: string[] = [];
try {
  if (process.env.SERVER_REF) {
    const commit = command('git',['rev-parse','--verify',`${process.env.SERVER_REF}^{commit}`]);
    serverCommit = commit;
    command('git',['archive','--format=tar',`--output=${scratch}/source.tar`,commit]);
    mkdirSync(`${scratch}/source`);
    command('tar',['-xf',`${scratch}/source.tar`,'-C',`${scratch}/source`]);
    env.LOAD_SERVER_SOURCE = `${scratch}/source`;
  }
  if (!process.env.SERVER_REF && !process.env.LOAD_APP_IMAGE) serverCommit = command('git',['rev-parse','HEAD']);
  console.log(`Sign-in measurement: ${project}; artifacts: ${output}`);
  phase = 'build/start';
  docker(...compose,'up','-d',...(process.env.LOAD_APP_IMAGE ? ['--no-build'] : ['--build']),'--wait');
  if (controller.signal.aborted) throw new Error('Interrupted during setup');
  const app = docker(...compose,'ps','-q','app');
  const db = docker(...compose,'ps','-q','db');
  const base = `http://127.0.0.1:${port}`;
  async function post(path: string, body: unknown, expected: number) {
    const response = await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
    if (response.status !== expected) throw new Error(`Seed ${path} status ${response.status}`);
    return response;
  }
  phase = 'seed';
  const setup: SetupRequest = {email:'seed@example.invalid',password,name:'Load Owner',organization_name:'Organization A',setup_token:env.LOAD_SETUP_TOKEN};
  await (await post('/api/v1/setup',setup,201)).arrayBuffer();
  // Reuse the server-generated Argon2 seed hash; no hash or credential goes to artifacts.
  sql(`BEGIN;
    INSERT INTO accounts(id,email,password_hash)
      SELECT gen_random_uuid(), kind || '-' || n || '@example.invalid', password_hash
      FROM accounts CROSS JOIN generate_series(0,${config.accounts-1}) n CROSS JOIN (VALUES ('known'),('correct')) k(kind)
      WHERE email='seed@example.invalid';
    INSERT INTO users(organization_id,id,account_id,name,role)
      SELECT o.organization_id,gen_random_uuid(),a.id,'Load Member','member' FROM accounts a CROSS JOIN organizations o
      WHERE a.email LIKE 'known-%' OR a.email LIKE 'correct-%';
    INSERT INTO organizations(organization_id,name) VALUES(gen_random_uuid(),'Organization B');
    INSERT INTO accounts(id,email,password_hash) SELECT gen_random_uuid(),'reader@example.invalid',password_hash FROM accounts WHERE email='seed@example.invalid';
    INSERT INTO users(organization_id,id,account_id,name,role)
      SELECT o.organization_id,gen_random_uuid(),a.id,'Load Reader','owner' FROM accounts a CROSS JOIN organizations o
      WHERE a.email='reader@example.invalid' AND o.name='Organization B'; COMMIT;`);
  const identity = await (await post('/api/v1/native/session',{email:'reader@example.invalid',password},200)).json() as NativeSessionResponse;
  const organization = identity.identity.organizations[0]?.organization_id;
  if (!organization) throw new Error('Missing Organization B seed');
  const read = await fetch(`${base}/api/v1/orgs/${organization}/channels`, {headers:{Authorization:`Bearer ${identity.token}`},
    signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
  if (read.status !== 200) throw new Error('Organization B preflight failed');
  await read.arrayBuffer();
  writeFileSync(`${output}/metadata.json`, JSON.stringify({project,config,port,node:process.version,
    allocator:Object.fromEntries(Object.entries(allocator).map(([key,value]) => [key,value ?? null])), postDrainIdleMs:idleMs,
    serverRef:process.env.SERVER_REF ?? null, serverCommit,
    serverDirty:process.env.SERVER_REF || process.env.LOAD_APP_IMAGE ? null : command('git',['status','--porcelain']),
    imageTag:env.LOAD_APP_IMAGE, appImage:docker('inspect','--format','{{.Image}}',app), dbImage:docker('inspect','--format','{{.Image}}',db),
    started:new Date().toISOString(),platform:platform(),arch:arch(),hostCpus:cpus().length,hostMemory:totalmem(),
    docker:JSON.parse(docker('info','--format','{"version":{{json .ServerVersion}},"cpus":{{json .NCPU}},"memory":{{json .MemTotal}}}')),
    harness:Object.fromEntries(['load/signin.ts','load/signin-workload.ts','load/signin-summary.ts','load/compose.yml'].map(path =>
      [path,createHash('sha256').update(readFileSync(path)).digest('hex')])),
    sampling:'During scheduling and drain, plus a separate sample after 12 s idle; CPU 100% = one core; VmRSS/RssAnon/Threads from /proc/1/status; pg_stat_activity app-role client backends excluding sampler; sampled peaks can miss spikes',
    transport:'host loopback published HTTP; synthetic trusted client IPs in disposable app only'}, null,2));
  const sample = (postIdle = false) => {
    if (sampling) return sampling;
    const at = new Date().toISOString();
    sampling = Promise.all([
      exec('docker',['stats','--no-stream','--format','{{.CPUPerc}}',app],{env}),
      exec('docker',['exec',app,'cat','/proc/1/status'],{env}),
      exec('docker',[...compose,'exec','-T','db','psql','-X','-U','fukulow','-d','fukulow','-Atc',
        `SELECT count(*),count(*) FILTER (WHERE state='active') FROM pg_stat_activity WHERE datname=current_database() AND usename='fukulow_app' AND backend_type='client backend' AND pid<>pg_backend_pid()`],{env}),
    ]).then(([cpu,rss,connections]) => {
      const value = resourceSample(at,cpu.stdout,rss.stdout,connections.stdout);
      if (postIdle) postIdleSample=value;
      else samples.push(value);
    }).catch(() => { samplingErrors.push(`Resource sample failed at ${at}`); }).finally(() => { sampling=undefined; });
    return sampling;
  };
  phase = 'workload';
  sample(); timer=setInterval(() => { sample(); },1000);
  result = await workload(base,password,identity.token,organization,config,controller.signal);
  clearInterval(timer); timer=undefined; await sampling;
  if (controller.signal.aborted || !samples.length || samplingErrors.length || !result.attempts.length) throw new Error('Incomplete measurement');
  phase = 'post-drain idle';
  await delay(idleMs,undefined,{signal:controller.signal});
  await sample(true);
  if (controller.signal.aborted || !postIdleSample || samplingErrors.length) throw new Error('Incomplete idle measurement');
  console.log('SIGNIN_SUMMARY '+JSON.stringify(summarize(result.attempts,samples,postIdleSample)));
} catch {
  // Child-process errors can include environment/SQL. Never serialize raw errors.
  failed=true;
  console.error(`Sign-in measurement failed during ${phase}; credentials/errors suppressed.`);
} finally {
  if (timer) clearInterval(timer);
  await sampling;
  writeFileSync(`${output}/results.json`,JSON.stringify({complete:!failed,phase,config,...result,samples,postIdleSample,samplingErrors,
    summary:summarize(result?.attempts ?? [],samples,postIdleSample)},null,2));
  try { docker(...compose,'down','--volumes'); } catch { cleanupErrors.push('Compose cleanup failed'); }
  if (!process.env.LOAD_APP_IMAGE) {
    try { if (docker('image','ls','-q',env.LOAD_APP_IMAGE)) docker('image','rm',env.LOAD_APP_IMAGE); }
    catch { cleanupErrors.push('Image cleanup failed'); }
  }
  rmSync(scratch,{recursive:true,force:true});
  process.off('SIGINT',interrupt); process.off('SIGTERM',interrupt);
  console.log(`Results: ${output}`);
}
if (cleanupErrors.length) console.error(cleanupErrors.join('; '));
process.exitCode=failed || cleanupErrors.length ? 1 : 0;
