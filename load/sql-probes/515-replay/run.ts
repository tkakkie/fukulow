import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { outsideCheckout } from '../../proxy-target.ts';
import { fixture, nights, partA, partC, type Arm } from '../../slice5/config.ts';
import { execute, extract, prepare, quote, type Bindings, type Statement } from './sql.ts';
import { describePlan, modes, pgbenchScript, pgbenchTimings, position, preparedState, psqlTiming, quantiles, sections, timings, type Cell } from './measure.ts';
import { channel, cmd, member, organization, owner, pgOptions, runtime, seed, stack, token, type Stack } from './stack.ts';
import { assertDockerHeadroom } from '../../harness-core/host.ts';
import { modeOf, stages } from '../../harness-core/stages.ts';

const usage = 'node load/sql-probes/515-replay/run.ts (--smoke | --rehearsal | --recorded) --out NEW_DIRECTORY_OUTSIDE_CHECKOUT';
const { values } = parseArgs({ options: { out: { type: 'string' }, smoke: { type: 'boolean' }, rehearsal: { type: 'boolean' }, recorded: { type: 'boolean' }, help: { type: 'boolean' } } });
if (values.help) { console.log(usage); process.exit(0); }
if (!values.out) throw new Error(usage);
const mode = modeOf(values);

const root = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
process.chdir(root);
const out = outsideCheckout(values.out);
mkdirSync(out, { mode: 0o700 });
const save = (path: string, value: unknown) => writeFileSync(join(out, path), JSON.stringify(value, null, 2) + '\n');
const text = (path: string, value: string) => writeFileSync(join(out, path), value + '\n');
const work = mkdtempSync(join(realpathSync(tmpdir()), 'fk515d-'));
const project = 'fk515d-' + randomUUID();
const smoke = mode === 'smoke';
// Rehearsal: the recorded fixture size end to end through setup, then one short cell and one block pair. Never evidence.
const rehearsal = mode === 'rehearsal';
const sizes = smoke ? [20_000, 10_000] : fixture.replayChannels.map(c => c.messages);
const blockSize = smoke ? 10 : rehearsal ? 50 : 500;
const warmups = smoke ? 2 : partC.warmups;
const order = rehearsal ? [['B', 'A']] as const : [['B', 'A'], ['A', 'B']] as const;
// Two arms of the full fixture plus WAL and settle margin; an estimate, checked on the Docker VM disk.
const requiredBytes = 2 * sizes.reduce((a, b) => a + b, 0) * 2048 + 4 * 1024 ** 3;
const cells = (rehearsal ? partC.cells.slice(0, 1) : partC.cells).map(name => {
  const [size, depth] = name.split('-');
  return { name, depth, size: sizes[size === '1M' ? 0 : 1] };
});
const arms: Arm[] = ['B', 'A'];
const cleanup: Stack[] = [];
const inventory = new Map<Arm, ReturnType<typeof extract>>();
const clusters = new Map<Arm, Stack>();
const samples: ReturnType<typeof sampleBlock>[] = [];
const run = stages(out, mode);
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { interrupted = true; });
const stopIfInterrupted = () => { if (interrupted) throw new Error('Interrupted'); };
const commits = Object.fromEntries(arms.map(a => [a, cmd('git', ['rev-parse', nights[3].commits[a] + '^{commit}'])])) as Record<Arm, string>;

function roleCheck(db: Stack, arm: Arm, role: string) {
  const state = JSON.parse(db.psql(`SELECT json_build_object(
    'currentRole', current_user, 'loginRole', session_user,
    'superuser', rolsuper, 'bypassRls', rolbypassrls,
    'tableOwner', pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.messages'::regclass)),
    'scopeBeforePlanning', NULLIF(current_setting('fukulow.organization_id',true),''),
    'settings', (SELECT json_object_agg(name,current_setting(name)) FROM pg_settings
      WHERE name IN ('statement_timeout','jit','row_security','shared_buffers','work_mem','effective_cache_size',
        'random_page_cost','plan_cache_mode','server_version','transaction_isolation','pg_stat_statements.track')),
    'rls', (SELECT json_object_agg(rel, row_security_active(to_regclass('public.' || rel)))
      FROM unnest(ARRAY['organizations','users','channels','channel_members','messages','message_mentions','channel_message_sequences'${arm === 'A' ? ",'channel_log'" : ''}]) rel))
    FROM pg_roles WHERE rolname=current_user;`, role)) as {
      currentRole: string; loginRole: string; superuser: boolean; bypassRls: boolean; tableOwner: string;
      scopeBeforePlanning: string | null; settings: Record<string, string>; rls: Record<string, boolean>;
    };
  const app = role === runtime;
  if (state.currentRole !== role || state.loginRole !== role || state.scopeBeforePlanning !== null ||
    state.settings.statement_timeout !== '10s' || state.settings.jit !== 'off' || state.settings.row_security !== 'on' ||
    Object.values(state.rls).some(active => active !== app) ||
    (app ? state.superuser || state.bypassRls : state.tableOwner !== owner)) throw new Error('Unexpected probe role or RLS state');
  return state;
}

function binding(cell: Cell): Bindings {
  return { organization, organizationText: organization, token, member, revision: 0,
    channel: channel(cell.name.startsWith('1M') ? 0 : 1), after: position(cell, 0), through: cell.size, limit: partC.limit + 1 };
}

function plans(db: Stack, mode: typeof modes[number], statements: Statement[], bindings: Bindings, role: string, precontext = false) {
  const utility = (stmt: Statement) =>
    role === owner && stmt.name === 'watermark_commit' ? 'ROLLBACK' : stmt.sql;
  const explain = (stmt: Statement) => stmt.parameters ?
    `\\echo @${stmt.name}\nEXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) ${execute(stmt, bindings)};` :
    utility(stmt) + ';';
  const standalone = statements.length === 1;
  // Owner reads are always rolled back. A's pre-context variants set the same
  // Organization before planning while retaining the real statement wrapper.
  const outer = standalone && (role === owner || precontext);
  const begin = outer ? 'BEGIN;\n' + (precontext ? `SET LOCAL fukulow.organization_id = ${quote(organization)};\n` : '') : '';
  const measured = statements.map(stmt => {
    if (role !== owner || standalone || !stmt.autocommit) return explain(stmt);
    return 'BEGIN;\n' + explain(stmt) + '\nROLLBACK;';
  }).join('\n');
  const output = sections(db.psql([
    begin, ...statements.map(prepare), measured, ...(outer ? ['ROLLBACK;'] : []), '\\echo @prepared', preparedState,
  ].join('\n'), role, mode));
  const details = Object.fromEntries(statements.map(stmt => {
    const raw = output.get(stmt.name);
    if (!stmt.parameters) return [stmt.name, { utility: utility(stmt), explainSupported: false }];
    if (!raw || stmt.rows === undefined) throw new Error('Missing EXPLAIN result for ' + stmt.name);
    const json = JSON.parse(raw) as Parameters<typeof describePlan>[0];
    return [stmt.name, { raw: json, summary: describePlan(json, stmt.rows) }];
  }));
  if (output.size !== statements.filter(stmt => stmt.parameters).length + 1 || !output.has('prepared')) throw new Error('Unexpected EXPLAIN output');
  return { role, mode, precontext, bindings, statements: details, prepared: JSON.parse(output.get('prepared')!) as unknown };
}

function sampleBlock(arm: Arm, cell: Cell, block: number, db: Stack, sequence: Statement[]) {
  const dir = join(arm, cell.name);
  const first = block * blockSize - warmups;
  const count = blockSize + warmups;
  const bindings = binding(cell);
  const psqlLog = db.psql(psqlTiming(sequence, cell, bindings, first, count), runtime);
  text(join(dir, `block-${block}-psql.log`), psqlLog);
  const result = timings(psqlLog, sequence.map(s => s.name), first, count);
  const vars = Object.fromEntries(Object.entries(bindings).map(([name, value]) => [name, quote(value)]));
  const { report, log } = db.pgbench(pgbenchScript(sequence, cell, first), { ...vars, client_sample: 0 }, count);
  text(join(dir, `block-${block}-pgbench.log`), log);
  const elapsed = pgbenchTimings(log, count);
  text(join(dir, `block-${block}-pgbench.txt`), report);
  const joined = result.samples.map((sample, i) => ({
    ...sample, after: position(cell, sample.index), warmup: i < warmups, pgbenchMs: elapsed[i],
  }));
  save(join(dir, `block-${block}-timings.json`), { first, warmups, prepared: result.prepared, samples: joined });
  return { arm, cell: cell.name, samples: joined.filter(s => !s.warmup) };
}

function requestInventory(arm: Arm, sequence: Statement[]) {
  const acquisitions = arm === 'A' ? 4 : 2;
  return [
    `### ${arm} (${commits[arm]})`, '',
    `Handler \`server/src/${arm === 'A' ? 'messages/log.rs:333' : 'messages.rs:87'}\`.`, '',
    `${sequence.length} SQL statements, ${sequence.length + acquisitions} synchronous round trips on a warm reused pool connection path (${acquisitions} checkout checks), and ${acquisitions} additional asynchronous return checks.`, '',
    ...sequence.map((s, i) => `${i + 1}. \`${s.name}\` · ${s.refs.split(', ').map(ref => `\`server/src/${ref}\``).join(', ')}`),
    '',
  ];
}

function summary() {
  const a = inventory.get('A')?.sequence;
  const b = inventory.get('B')?.sequence;
  const lines = ['# #515 R1 SQL diagnosis', '', smoke ? '**SMOKE — shape validation only.**' : rehearsal ? '**REHEARSAL — full-size setup check, never evidence.**' : '**Recorded SQL diagnosis.**',
    '', 'This probe does not judge the cause of the formal R1 HTTP gap; the report compares the results below with it. The probe measures the settled database on one connection without the concurrent sender, pool scheduling, Rust row decoding or HTTP. The reference HTTP p95 difference is approximately 0.8–1.1 ms.', '',
    '## Request inventory', '', ...(a ? requestInventory('A', a) : []), ...(b ? requestInventory('B', b) : []),
    'A repeats visibility inside its page. Mentions and history generation are inline in A, and Mentions are inline in B. The requested limit is 50 and both SQL pages fetch 51 to test has_more.', '',
    'For a reused warm connection, the A–B difference is +1 SQL round trip and +2 checkout checks, for +3 synchronous round trips. The pool also sends +2 asynchronous return checks. Each check is a SQLx Sync/ReadyForQuery exchange with no SQL. A cache miss can require a separate prepare/describe exchange for an uncached bound SQL string (up to 6 such executions in A and 5 in B); connection establishment is outside the count.', '',
    '## SQL timing results', '',
    'The pgbench sequence p95 includes command dispatch and DB round trips. The psql sequence p95 sums observed round-trip times within each sample. Individual statement percentiles describe separate distributions and cannot be added to recover a request percentile.', '',
    '| Cell | Arm | Samples | pgbench p50 / p95 (ms) | psql sequence p50 / p95 (ms) | page p50 / p95 (ms) |',
    '|---|---|---:|---:|---:|---:|'];
  const differences = [];
  const fmt = (q: ReturnType<typeof quantiles>) => `${q.p50.toFixed(3)} / ${q.p95.toFixed(3)}`;
  for (const cell of cells) {
    const p95 = new Map<Arm, { whole: number; sum: number; page: number }>();
    for (const arm of arms) {
      const rows = samples.filter(s => s.cell === cell.name && s.arm === arm).flatMap(s => s.samples);
      if (rows.length === 0) continue;
      const whole = quantiles(rows.map(s => s.pgbenchMs));
      const sum = quantiles(rows.map(s => s.roundTripSumMs));
      const statements = Object.fromEntries(Object.keys(rows[0].statementsMs).map(name =>
        [name, quantiles(rows.map(s => s.statementsMs[name]))]));
      lines.push(`| ${cell.name} | ${arm} | ${rows.length} | ${fmt(whole)} | ${fmt(sum)} | ${fmt(statements.page)} |`);
      save(join(arm, cell.name, 'quantiles.json'), { whole, roundTripSum: sum, statements });
      p95.set(arm, { whole: whole.p95, sum: sum.p95, page: statements.page.p95 });
    }
    const a = p95.get('A'), b = p95.get('B');
    if (a && b) differences.push(`- ${cell.name} A − B p95 differences were ${(a.whole - b.whole).toFixed(3)} ms for pgbench, ${(a.sum - b.sum).toFixed(3)} ms for the psql sequence and ${(a.page - b.page).toFixed(3)} ms for the page.`);
  }
  lines.push('', ...differences, '', 'Each plan file includes raw JSON, plan trees with Index Cond and actual rows × loops, shared hit/read and temp blocks, and planning and execution times. Transaction utility commands are timed and have no PostgreSQL EXPLAIN plan.');
  text('summary.md', lines.join('\n'));
}

try {
  const setup: Record<string, unknown> = {};
  for (const arm of arms) {
    stopIfInterrupted();
    run.enter('fk515d: ' + arm + ' source and PostgreSQL stack');
    const source = join(work, arm);
    mkdirSync(source);
    const tar = source + '.tar';
    cmd('git', ['archive', '--format=tar', '--output=' + tar, commits[arm], 'server/src', 'server/migrations', 'load/compose.yml', 'deploy']);
    cmd('tar', ['-xf', tar, '-C', source]);
    const extracted = extract(arm, (path, first, last = first) =>
      readFileSync(join(source, 'server/src', path), 'utf8').split('\n').slice(first - 1, last).join('\n'), partC.limit + 1);
    inventory.set(arm, extracted);
    mkdirSync(join(out, arm));
    save(join(arm, 'statements.json'), extracted);
    const db = stack(source, work, arm, commits[arm], `${project}-${arm.toLowerCase()}`);
    cleanup.push(db);
    clusters.set(arm, db);
    const image = await db.start();
    if (arm === 'B' && !smoke) setup.headroom = assertDockerHeadroom(db.pgImage!, requiredBytes);
    run.enter('fk515d: ' + arm + ' fixture and first settle');
    const seeded = seed(db, arm, sizes);
    if (arm === 'A' && seeded.checksum !== (setup.B as { checksum: string }).checksum) throw new Error('Fixture checksums differ');
    setup[arm] = { ...image, ...seeded, runtime: roleCheck(db, arm, runtime), ownerControl: roleCheck(db, arm, owner) };
  }
  const harnessPath = fileURLToPath(new URL('.', import.meta.url));
  const corePath = fileURLToPath(new URL('../../harness-core/', import.meta.url));
  const hashes = Object.fromEntries([harnessPath, corePath].flatMap(dir => readdirSync(dir).filter(file => file.endsWith('.ts')).sort()
    .map(file => [(dir === corePath ? 'harness-core/' : '') + file, createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')])));
  save('metadata.json', { mode, smoke, commits, setup, cells, fixture: { organizations: 1, members: fixture.members, channels: fixture.channels, bodyBytes: Buffer.byteLength(fixture.shortBody) }, planModes: modes, timingPlanMode: 'auto', order, blockSize, warmups,
    cache: 'VACUUM FREEZE ANALYZE and CHECKPOINT after prefill, then VACUUM ANALYZE, CHECKPOINT and idle per cell; client warmups for timing; no OS cache flush',
    client: 'One psql/pgbench client over TCP loopback in the PostgreSQL container per block',
    pgOptions, node: process.version, harnessCommit: cmd('git', ['rev-parse', 'HEAD']), harnessHashes: hashes, started: new Date().toISOString() });

  for (const cell of cells) {
    stopIfInterrupted();
    run.enter('fk515d: ' + cell.name + ' settle and plans');
    for (const arm of arms) {
      mkdirSync(join(out, arm, cell.name));
      clusters.get(arm)!.setup('VACUUM (ANALYZE);\nCHECKPOINT;');
    }
    await new Promise(resolve => setTimeout(resolve, partA.idleSeconds * 1000));
    for (const arm of arms) {
      const db = clusters.get(arm)!;
      const { sequence, controls } = inventory.get(arm)!;
      for (const mode of modes) {
        stopIfInterrupted();
        run.enter(`fk515d: ${arm} ${cell.name} ${mode} plans`);
        const bindings = binding(cell);
        // EXPLAIN ANALYZE plans are the first recorded samples; the first cell's VACUUM and idle are still setup.
        run.startSampling();
        const results = {
          runtime: plans(db, mode, sequence, bindings, runtime),
          ownerRolledBack: plans(db, mode, sequence, bindings, owner),
          controls: Object.fromEntries(controls.map(stmt => [stmt.name, {
            runtime: plans(db, mode, [stmt], bindings, runtime, stmt.name.endsWith('_precontext')),
            ownerRolledBack: plans(db, mode, [stmt], bindings, owner, stmt.name.endsWith('_precontext')),
          }])),
        };
        save(join(arm, cell.name, `plans-${mode}.json`), results);
      }
    }
    for (const [block, pair] of order.entries()) {
      stopIfInterrupted();
      run.enter(`fk515d: ${cell.name} block ${block} host load`);
      save(`host-${cell.name}-${block}.json`, { time: new Date().toISOString(), arms: pair,
        uptime: cmd('uptime', []), processes: cmd('ps', ['-axo', 'pid,pcpu,comm']),
        docker: cmd('docker', ['stats', '--no-stream']) });
      for (const arm of pair) {
        run.enter(`fk515d: ${arm} ${cell.name} block ${block} timing`);
        samples.push(sampleBlock(arm, cell, block, clusters.get(arm)!, inventory.get(arm)!.sequence));
        run.done(run.stage);
      }
    }
  }
} catch (error) {
  console.error(`${run.stage}: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  for (const db of cleanup.reverse()) {
    try { db.stop(); } catch {
      console.error('fk515d: compose cleanup failed for ' + project);
      process.exitCode = 1;
    }
  }
  rmSync(work, { recursive: true, force: true });
  const status = run.finish(summary, { failed: Boolean(process.exitCode), interrupted });
  if (status.summaryFailed) process.exitCode = 1;
  console.log('fk515d: outcome ' + status.outcome);
  if (interrupted) process.exitCode = 1;
  console.log('fk515d: output ' + out);
}
