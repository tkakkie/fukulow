import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { outsideCheckout } from '../../proxy-target.ts';
import { fixture, nights, partA, partC, type Arm } from '../../slice5/config.ts';
import { sleep } from '../../slice5/stack.ts';
import { assertDockerHeadroom } from '../../harness-core/host.ts';
import { modeOf, stages } from '../../harness-core/stages.ts';
import { position, type Cell } from '../515-replay/measure.ts';
import { extract } from '../515-replay/sql.ts';
import { channel, cmd, organization, pgOptions, runtime, seed, stack, type Stack } from '../515-replay/stack.ts';
import { applyArmPatch, archive, build, prepareDriver, type Variant } from './images.ts';
import { components, parseTraces, prefix, sqlLabels, summary, type Block, type ClientSample } from './results.ts';

const usage = 'node load/sql-probes/515-app/run.ts (--smoke | --rehearsal | --recorded) --out NEW_DIRECTORY_OUTSIDE_CHECKOUT';
const { values } = parseArgs({ options: { out: { type: 'string' }, smoke: { type: 'boolean' },
  rehearsal: { type: 'boolean' }, recorded: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) { console.log(usage); process.exit(0); }
const mode = modeOf(values);
if (!values.out) throw new Error(usage);
process.chdir(realpathSync(fileURLToPath(new URL('../../../', import.meta.url))));
const out = outsideCheckout(values.out);
mkdirSync(out, { mode: 0o700 });
const save = (name: string, data: unknown) => writeFileSync(join(out, name + '.json'), JSON.stringify(data, null, 2) + '\n');

const project = 'fk515a-' + randomUUID();
const arms = ['B', 'A'] as const;
const smoke = mode === 'smoke';
const rehearsal = mode === 'rehearsal';
const sizes = smoke ? [20_000, 10_000] : fixture.replayChannels.map(c => c.messages);
const blockSize = smoke ? 10 : rehearsal ? 50 : 500;
const warmups = smoke ? 2 : partC.warmups;
const order = rehearsal ? [['B', 'A']] as const : [['B', 'A'], ['A', 'B']] as const;
const cells = (rehearsal ? partC.cells.slice(0, 1) : partC.cells).map(name => {
  const [size, depth] = name.split('-');
  return { name, depth, size: sizes[size === '1M' ? 0 : 1] };
});
const token = randomBytes(32).toString('hex');
const readerHash = createHash('sha256').update(token).digest('hex');
const run = stages(out, mode);
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { interrupted = true; });
function stopIfInterrupted() {
  if (interrupted) throw new Error('Interrupted');
}
type Instance = { db: Stack; app: ReturnType<Stack['startApp']>; generation: string | null; traceIds: Set<number>; dropped: number };
const instances = new Map<string, Instance>();
const cleanup: Stack[] = [];
const blocks: Block[] = [];
let id = 0;
let work: string | undefined;

function runtimeCheck(db: Stack, arm: Arm) {
  const state = JSON.parse(db.psql(`SELECT json_build_object(
    'role', current_user, 'loginRole', session_user, 'bypassRls', rolbypassrls, 'superuser', rolsuper,
    'scope', NULLIF(current_setting('fukulow.organization_id',true),''),
    'settings', (SELECT json_object_agg(name,current_setting(name)) FROM pg_settings
      WHERE name IN ('statement_timeout','jit','row_security','plan_cache_mode','shared_buffers','work_mem',
        'effective_cache_size','random_page_cost','server_version','transaction_isolation','pg_stat_statements.track')),
    'rls', (SELECT json_object_agg(rel, row_security_active(to_regclass('public.' || rel))) FROM unnest(
      ARRAY['organizations','users','channels','channel_members','messages','message_mentions','channel_message_sequences'${arm === 'A' ? ",'channel_log'" : ''}]) rel))
    FROM pg_roles WHERE rolname=current_user;`, runtime));
  if (state.role !== runtime || state.loginRole !== runtime || state.bypassRls || state.superuser || state.scope !== null ||
    state.settings.statement_timeout !== '10s' || state.settings.jit !== 'off' || state.settings.row_security !== 'on' ||
    state.settings.plan_cache_mode !== 'auto' || Object.values(state.rls).some(active => active !== true)) {
    throw new Error('Runtime role, settings or RLS differ from the replay probe');
  }
  return state;
}

async function request(instance: Instance, arm: Arm, cell: Cell, index: number, warmup: boolean): Promise<ClientSample> {
  stopIfInterrupted();
  const after = position(cell, index);
  const sample = id++;
  const suffix = arm === 'A' ? 'events' : 'messages';
  const generation = instance.generation ? `&history_generation=${instance.generation}` : '';
  const url = `${instance.app.base}/api/v1/orgs/${organization}/channels/${channel(cell.name.startsWith('1M') ? 0 : 1)}/${suffix}?after_seq=${after}&limit=${partC.limit}${generation}`;
  const started = performance.now();
  const response = await fetch(url, { headers: { Authorization: 'Bearer ' + token, 'x-fk515-sample': String(sample) },
    redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const bytes = await response.arrayBuffer();
  const httpMs = performance.now() - started;
  if (response.status !== 200) throw new Error(`Replay HTTP ${response.status} for sample ${sample}`);
  const body = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const page = arm === 'A' ? body.events : body.messages;
  if (!Array.isArray(page) || page.length !== partC.limit || body.has_more !== true ||
    (arm === 'A' && body.history_generation !== instance.generation) ||
    page.some((entry, i) => entry?.seq !== after + 1 + i || (arm === 'A' && entry.type !== 'message'))) {
    throw new Error(`Unexpected replay page for sample ${sample}`);
  }
  return { id: sample, after, httpMs, warmup };
}

async function readBlock(instance: Instance, variant: Variant, stem: string, client: ClientSample[]) {
  const expected = new Set([...instance.traceIds, ...client.map(s => s.id)]);
  // A return check can finish after the client receives the response. Read
  // outside the timing block and wait for the writer to finish the last line.
  for (let attempt = 0; attempt < 10; attempt++) {
    const raw = instance.app.traceLog();
    const log = raw.slice(0, raw.lastIndexOf('\n') + 1);
    const { traces, dropped } = parseTraces(log);
    instance.dropped = dropped;
    if (dropped > 0) throw new Error(`Diagnostic writer reported ${dropped} dropped traces`);
    if (variant === 'control') {
      if (traces.size !== 0) throw new Error('Unpatched app emitted diagnostic traces');
      return traces;
    }
    if ([...traces.keys()].some(key => !expected.has(key))) throw new Error('Unexpected trace ID in app logs');
    if (traces.size === expected.size) {
      const blockIds = new Set(client.map(s => s.id));
      const lines = log.split('\n').filter(line => line.startsWith(prefix) && blockIds.has(Number(/^\[(\d+),/.exec(line.slice(prefix.length))?.[1])));
      writeFileSync(join(out, stem + '-traces.jsonl'), lines.map(line => line.slice(prefix.length)).join('\n') + '\n');
      instance.traceIds = expected;
      return traces;
    }
    await sleep(200);
  }
  throw new Error('Incomplete request traces');
}

async function sampleBlock(arm: Arm, variant: Variant, cell: Cell, block: number) {
  const instance = instances.get(arm + variant)!;
  const stem = `${cell.name}-${block}-${variant}-${arm}`;
  run.enter(stem);
  save(stem + '-host', { at: new Date().toISOString(), uptime: cmd('uptime', []),
    processes: cmd('ps', ['-axo', 'pid,pcpu,comm']), docker: cmd('docker', ['stats', '--no-stream']) });
  const client: ClientSample[] = [];
  try {
    for (let n = -warmups; n < blockSize; n++) {
      if (n === 0) run.startSampling();
      client.push(await request(instance, arm, cell, block * blockSize + n, n < 0));
    }
  } finally {
    save(stem + '-http', client);
  }
  const traces = await readBlock(instance, variant, stem, client);
  const samples = client.map(sample => ({ ...sample, ...(variant === 'patched' &&
    { trace: components(arm, traces.get(sample.id)!, sample.httpMs) }) }));
  if (variant === 'patched') save(stem + '-components', samples);
  blocks.push({ arm, variant, cell: cell.name, block, samples });
  run.done(stem);
}

let complete = false;
try {
  if (cmd('docker', ['ps', '-q'])) throw new Error('The diagnostic requires an idle Docker host');
  work = mkdtempSync(join(realpathSync(tmpdir()), 'fk515a-'));
  const commits = Object.fromEntries(arms.map(arm => [arm, cmd('git', ['rev-parse', nights[3].commits[arm] + '^{commit}'])])) as Record<Arm, string>;
  const harness = cmd('git', ['rev-parse', 'HEAD']);
  const inputs = fileURLToPath(new URL('.', import.meta.url));
  const harnessHashes = Object.fromEntries(['run.ts', 'images.ts', 'results.ts', 'patch-A.diff', 'patch-B.diff', 'patch-sqlx-core.diff', 'patch-sqlx-postgres.diff']
    .map(name => [name, createHash('sha256').update(readFileSync(join(inputs, name))).digest('hex')]));
  const setup: Record<string, unknown> = {};
  const metadata = { project, mode, commits, harness, harnessHashes, node: process.version, pgOptions,
    client: 'Sequential HTTP from the host, timed through body consumption. App and DB communicate over the Compose bridge.',
    cache: 'Freeze/analyze and checkpoint after seed, then analyze and checkpoint with an idle window for each cell.',
    fixture: { members: fixture.members, channels: fixture.channels, organizations: 1, bodyBytes: Buffer.byteLength(fixture.shortBody), sizes },
    cells, order, blockSize, warmups, setup };
  save('metadata', metadata);
  run.enter('Preparing locked SQLx instrumentation');
  const driver = await prepareDriver(work);
  let checksum: string | undefined;
  let headroomChecked = smoke;
  for (const arm of arms) {
    stopIfInterrupted();
    const source = archive(commits[arm], work, arm);
    const inventory = extract(arm, (file, first, last = first) =>
      readFileSync(join(source, 'server/src', file), 'utf8').split('\n').slice(first - 1, last).join('\n'), partC.limit + 1);
    if (inventory.sequence.map(s => s.name).join() !== sqlLabels[arm].join()) throw new Error('Statement inventory differs from trace labels');
    save(arm + '-statements', inventory);
    for (const variant of ['control', 'patched'] as const) {
      stopIfInterrupted();
      run.enter(`Building ${arm} ${variant}`);
      const patches = variant === 'patched' ? applyArmPatch(source, arm, driver) : null;
      const image = await build(source, commits[arm], patches);
      stopIfInterrupted();
      run.enter(`Migrating and seeding ${arm} ${variant}`);
      const key = arm + variant;
      const db = stack(source, work, arm, commits[arm], project + '-' + key.toLowerCase(), image.tag);
      cleanup.push(db);
      const migration = await db.start();
      if (migration.migrationImageId !== image.id) throw new Error('Migration image changed after build');
      if (!headroomChecked) {
        setup.headroom = assertDockerHeadroom(db.pgImage, 4 * sizes.reduce((a, b) => a + b, 0) * 2048 + 4 * 1024 ** 3);
        headroomChecked = true;
      }
      const seeded = seed(db, arm, sizes, readerHash);
      checksum ??= seeded.checksum;
      if (checksum !== seeded.checksum) throw new Error('Fixture checksums differ');
      const role = runtimeCheck(db, arm);
      const app = db.startApp();
      instances.set(key, { db, app, generation: seeded.generation, traceIds: new Set(), dropped: 0 });
      setup[key] = { image, migration, seeded, role };
      save('metadata', metadata);
    }
  }
  for (const cell of cells) {
    stopIfInterrupted();
    run.enter(`Settling ${cell.name}`);
    for (const { db } of instances.values()) db.setup('VACUUM (ANALYZE);\nCHECKPOINT;');
    await sleep(partA.idleSeconds * 1000);
    for (const [block, pair] of order.entries()) {
      const variants = block % 2 === 0 ? ['patched', 'control'] as const : ['control', 'patched'] as const;
      for (const variant of variants) {
        for (const arm of pair) {
          stopIfInterrupted();
          await sampleBlock(arm, variant, cell, block);
        }
      }
    }
  }
  complete = true;
} catch (error) {
  console.error(`${run.stage} — ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  for (const db of cleanup.reverse()) {
    try { db.stop(); } catch {
      console.error('Compose cleanup failed for ' + project);
      process.exitCode = 1;
    }
  }
  if (work) rmSync(work, { recursive: true, force: true });
  const dropped = [...instances.values()].reduce((total, instance) => total + instance.dropped, 0);
  const status = run.finish(() => writeFileSync(join(out, 'summary.md'), summary(mode, blocks, complete, dropped) + '\n'),
    { failed: Boolean(process.exitCode) || dropped > 0, interrupted, invalidEvidence: !complete || dropped > 0 });
  if (status.summaryFailed || interrupted) process.exitCode = 1;
  console.log(`fk515a ${status.outcome} — ${out}`);
}
