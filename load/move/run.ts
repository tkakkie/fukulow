import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { k6CeilingWarnings, readTimingProblems, sendTimingProblems } from './diagnostic-evidence.ts';
import { captureDiagnostic, diagnosticImage, diagnosticOutput } from './diagnostic.ts';
import { attributionLabel, diagnosticLabel, diagnosticMode, diagnosticSelection, readSampleEnvironment, rejectDiagnosticImage, remainingArmsSkipped,
  type ReadLanes } from './diagnostic-mode.ts';
import { buildFixture, committedMoves, head, type Seeded } from './fixture.ts';
import { armInvalid, infrastructureFailure, judge, type Attempt, type Measurement, type Result } from './judge.ts';
import { latency, storage } from './measure.ts';
import { moveLimits, plan, rehearsalPlan, rehearsalSteps, stepId, steps, thresholds, type Plan, type Step } from './plan.ts';
import { render } from './report.ts';
import { command, docker, sampler, sleep, startStack, type Stack } from '../slice5/stack.ts';
import { assertDockerHeadroom } from '../harness-core/host.ts';
import { stages, type Mode } from '../harness-core/stages.ts';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runLabel = 'io.fukulow.move.run';
const stepLabel = 'io.fukulow.move.step';
const revisionLabel = 'org.opencontainers.image.revision';
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export function checkImageRevision(commit: string, revision: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('--commit requires a full commit SHA');
  if (revision !== commit) throw new Error('App image revision does not equal --commit');
}

// sampled: this attempt reached its measurement boundary. A failure after it is a result and never reruns (#769).
export function canRerun(attempt: Attempt, used: boolean, smoke: boolean, aborted: boolean, sampled: boolean) {
  return attempt.infrastructure === infrastructureFailure && !used && !smoke && !aborted && !sampled;
}

// Report the Docker daemon condition alone. Docker command diagnostics can
// contain fixture parameters and are never copied into public result files.
async function daemonUnavailable() {
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 });
    return false;
  } catch (error) {
    const { stderr } = error as { stderr?: string };
    return /cannot connect to the docker daemon|error during connect|docker daemon is not running/i.test(stderr ?? '');
  }
}

function cleanup(project: string, step?: string) {
  const filters = ['--filter', `label=${runLabel}=${project}`, ...(step ? ['--filter', `label=${stepLabel}=${step}`] : [])];
  for (const kind of ['container', 'volume', 'network']) {
    const ids = docker(kind, 'ls', kind === 'container' ? '-aq' : '-q', ...filters).split('\n').filter(Boolean);
    if (ids.length) docker(kind, 'rm', ...(kind === 'container' ? ['-f', '-v'] : []), ...ids);
  }
}

export async function generator(stack: Stack, seeded: Seeded, p: Plan, step: Step, dir: string, labels: Record<string, string>, k6: string, signal: AbortSignal,
  startSampling: () => void, diagnosticRun = false, readLanes: ReadLanes = 'all') {
  save(join(dir, 'data.json'), seeded.data);
  save(join(dir, 'tokens.json'), seeded.tokens);
  const name = `${stack.env.LOAD_PROJECT}-k6`;
  const output = diagnosticRun ? diagnosticOutput(dir) : undefined;
  const generatorArgs = ['run', '--rm', '--name', name, '--network', stack.network, '--ulimit', 'nofile=65536:65536',
    '--user', `${process.getuid!()}:${process.getgid!()}`, '--cap-drop', 'ALL',
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    '-v', `${repo}:/work:ro`, '-v', `${dir}:/fixture:ro`, '-w', '/work',
    '-e', 'BASE_URL=http://app:8080', '-e', 'REQUEST_TIMEOUT_SECONDS=10', '-e', `MOVE_STEP=${JSON.stringify(step)}`,
    '-e', `MOVE_SMOKE=${Number(p.smoke)}`, ...(p.rehearsal ? ['-e', 'MOVE_REHEARSAL=1'] : []), ...(readLanes === 'all' ? [] : ['-e', `MOVE_READ_LANES=${readLanes}`]),
    ...(output?.dockerArgs ?? []),
    k6, 'run', '--quiet', ...(output?.k6Args ?? []), 'load/move/workload-k6.ts'];
  const prior = head(stack, seeded.data);
  const resources = diagnosticRun ? undefined : sampler(stack, () => name);
  const capture = output ? captureDiagnostic(stack, name, output.file,
    { partD: seeded.data.organization, reader: seeded.data.otherOrganization }) : undefined;
  const seconds = step.part === 'E' ? p.replaySeconds : p.seconds;
  let stdout = '', stderr = '';
  let problem: string | undefined;
  let diagnostic: string | undefined;
  let extra: (Awaited<ReturnType<NonNullable<typeof capture>['finish']>> & {
    k6CeilingWarnings: ReturnType<typeof k6CeilingWarnings>;
  }) | undefined;
  try {
    // Fixture files, the start position and capture setup above are setup; k6 starts the measured window.
    startSampling();
    const result = await exec('docker', generatorArgs, { signal, timeout: (seconds + 2 * p.drain + 30) * 1000 });
    stdout = result.stdout;
    if (diagnosticRun) stderr = result.stderr;
  } catch (error) {
    const exit = error as { code?: number | string; stdout?: string; stderr?: string };
    stdout = exit.stdout ?? '';
    if (diagnosticRun) stderr = exit.stderr ?? '';
    problem = `k6 did not complete successfully (exit ${exit.code ?? 'unknown'})`;
    const first = !diagnosticRun && exit.stderr?.match(/(?:^|\s)msg="([^"]{1,180})"/)?.[1];
    // Keep source/error class clues without any request values or fixture data.
    if (first && first.includes('workload-k6.ts') && /ReferenceError|TypeError|SyntaxError/.test(first))
      diagnostic = first.split(/ReferenceError|TypeError|SyntaxError/)[0].slice(0, 100);
  } finally {
    await resources?.stop();
    if (capture) extra = { ...await capture.finish(), k6CeilingWarnings: k6CeilingWarnings(stderr) };
  }
  const line = stdout.split('\n').find(l => l.startsWith('MOVE_RESULT '));
  if (!line) return { problem: problem ?? 'Missing k6 summary', diagnostic, samples: resources?.samples, extra };
  const raw = JSON.parse(line.slice('MOVE_RESULT '.length)) as Pick<Measurement, 'lanes' | 'topicReaders'> & { started?: number };
  const evidence = raw.started ? resources?.window(raw.started, raw.started + seconds * 1000) : undefined;
  const measurement: Measurement = { lanes: raw.lanes, topicReaders: raw.topicReaders, evidence: evidence?.evidence };
  if (step.arm === 'move' && step.part !== 'E') {
    try {
      const committed = committedMoves(stack, seeded.data, prior);
      measurement.moveVerified = committed > 0 && committed === raw.lanes.move?.accepted;
    } catch (error) {
      if (!diagnosticRun) throw error;
      problem ??= 'DIAGNOSTIC Move verification query failed';
    }
  }
  return { measurement, problem, diagnostic, samples: resources?.samples, cpu: evidence?.cpu, started: raw.started, extra };
}

const usage = 'Usage: node load/move/run.ts --out NEW_DIRECTORY [--commit FULL_SHA --image IMAGE | --diagnostic [--commit PINNED_SHA] [--sizes 100,1000] [--round 1] [--read-lanes all|channels|topics]] [--smoke | --rehearsal]';
// #758 D0 waiter value: Docker VM free space before the image builds, stacks and k6 output.
export const headroomBytes = 20 * 1024 ** 3;

// Mode, plan and arms of one invocation. Without --smoke or --rehearsal the run is the recorded job,
// unchanged: plan(false) and every formal step, or the DIAGNOSTIC selection.
export function selectRun(values: { smoke?: boolean; rehearsal?: boolean; diagnostic?: boolean; sizes?: string; round?: string;
  image?: string; commit?: string; 'read-lanes'?: string }) {
  if (values.smoke && values.rehearsal) throw new Error('Pass at most one of --smoke and --rehearsal');
  const mode: Mode = values.smoke ? 'smoke' : values.rehearsal ? 'rehearsal' : 'recorded';
  const selection = diagnosticSelection(values);
  const p: Plan = selection?.plan ?? (mode === 'rehearsal' ? rehearsalPlan() : plan(mode === 'smoke'));
  const orderedSteps = selection?.steps ?? (p.rehearsal ? rehearsalSteps(p) : steps(p));
  return { mode, selection, p, orderedSteps };
}

// #769 fail fast: stop after the first measured arm if judge() would already call it INVALID.
// DIAGNOSTIC arms keep their own missing-evidence stop (remainingArmsSkipped) after every arm.
export function firstArmInvalid(p: Plan, diagnostic: boolean, row: Result) {
  return diagnostic ? [] : armInvalid(p, row, row.attempts.at(-1));
}

// A rehearsal applies every per-arm validity check to its arms and judge()'s functional checks to each
// rehearsed round; it is clean only when none fails. Performance gates stay NOT EVALUATED in judge().
export function rehearsalChecks(p: Plan, results: Result[]) {
  const arms = results.map(row => ({ step: stepId(row), problems: armInvalid(p, row, row.attempts.at(-1)) }));
  const rehearsed = (part: string, size: number, round: number) => results.some(row => row.part === part && row.size === size && row.round === round);
  const functional = judge(p, results, true).rows.flatMap(row => row.rounds
    .filter(round => rehearsed(row.part, row.size, round.round) && round.functional.status !== 'PASS')
    .map(round => ({ step: `${row.part}-${row.size}-r${round.round}-functional`,
      problems: round.functional.reasons.length ? round.functional.reasons : [round.functional.status] })));
  return [...arms, ...functional];
}

// Any INVALID or unjudged verdict is never evidence. A valid FAIL stays evidence-eligible but fails the run.
export function verdictInvalid(verdict: ReturnType<typeof judge>) {
  return !(['PASS', 'FAIL'] as string[]).includes(verdict.overall)
    || verdict.rows.some(row => row.rounds.some(round => round.status === 'INVALID' || round.functional.status === 'INVALID'));
}

// status.json flags from the final verdict and exit decision (harness-core/stages.ts semantics).
export function statusFlags(o: { passed: boolean; finished: boolean; cleanupIssues: number; stoppedEarly: boolean; armProblem: boolean;
  diagnosticIncomplete: boolean; verdict?: ReturnType<typeof judge> }) {
  const incomplete = !o.finished || o.cleanupIssues > 0 || o.stoppedEarly || o.diagnosticIncomplete;
  return { failed: !o.passed || incomplete || o.armProblem, invalidEvidence: incomplete || (o.verdict !== undefined && verdictInvalid(o.verdict)) };
}

// results.json: complete is false and skipped lists the arms when scheduled work did not all run (for
// example a fail-fast stop). The verdict is still judged with the run's own completeness.
export function scheduledWork(finished: boolean, orderedSteps: Step[], ran: number) {
  const skipped = orderedSteps.slice(ran).map(stepId);
  return { complete: finished && skipped.length === 0, skipped };
}

function postgresImage() {
  const pg = /\n  db:\n    image: (\S+)/.exec(readFileSync(join(repo, 'load/compose.yml'), 'utf8'))?.[1];
  if (!pg) throw new Error('db image not found in load/compose.yml');
  return pg;
}

async function main() {
  const { values } = parseArgs({ options: { commit: { type: 'string' }, image: { type: 'string' },
    out: { type: 'string' }, smoke: { type: 'boolean' }, rehearsal: { type: 'boolean' }, diagnostic: { type: 'boolean' },
    sizes: { type: 'string' }, round: { type: 'string' }, 'read-lanes': { type: 'string' } } });
  const { mode, selection, p, orderedSteps } = selectRun(values);
  if (!values.out || (!selection && (!values.commit || !values.image))) throw new Error(usage);
  const commit = selection ? selection.commit : values.commit!;
  const attribution = selection && attributionLabel(selection.readLanes);
  const output = resolve(values.out);
  mkdirSync(output, { mode: 0o700 });
  const project = `fukulow-move-${randomUUID()}`;
  // status.json: setup-failure before the first measured sample, result-failure after it (#769).
  const run = stages(output, mode, project);
  const tag = `fukulow-move-diagnostic:${project}`;
  const scratch = mkdtempSync(join(platform() === 'darwin' ? '/private/tmp' : tmpdir(), 'fukulow-move-'));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const results: Result[] = [];
  const diagnosticArms: object[] = [];
  let rerun = false, complete = false;
  let stoppedEarly: string | undefined;
  const cleanupIssues: string[] = [];
  let image: { id: string; revision: string; patchSha256?: string } | undefined;
  try {
    run.enter('source');
    if (!selection) {
      const inspected = JSON.parse(docker('image', 'inspect', '--format',
        `{"id":{{json .Id}},"revision":{{json (index .Config.Labels "${revisionLabel}")}},"diagnostic":{{json (index .Config.Labels "${diagnosticLabel}")}}}`,
        values.image!)) as { id: string; revision: string; diagnostic: string | null };
      rejectDiagnosticImage(inspected.diagnostic || null);
      checkImageRevision(commit, inspected.revision);
      image = { id: inspected.id, revision: inspected.revision };
    }
    if (command('git', ['-C', repo, 'rev-parse', '--verify', commit + '^{commit}']) !== commit) throw new Error('Commit is unavailable locally');
    if (!p.smoke) {
      if (!selection && platform() !== 'darwin') throw new Error('Formal Move measurement requires a Mac');
      command('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, 'origin/main']);
    }
    let headroom: ReturnType<typeof assertDockerHeadroom> | undefined;
    if (!p.smoke) {
      run.enter('headroom');
      headroom = assertDockerHeadroom(postgresImage(), headroomBytes);
    }
    run.enter('build');
    const k6 = command('make', ['-s', '-C', repo, 'load-image']);
    const k6Id = docker('image', 'inspect', '--format', '{{.Id}}', k6);
    if (selection) {
      console.log('DIAGNOSTIC: building the instrumented Part D image' + (attribution ? ` (${attribution})` : ''));
      image = await diagnosticImage(repo, scratch, tag, abort.signal, selection);
    }
    if (!image) throw new Error('Missing app image');
    const harnessFiles = command('git', ['-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'load/move'])
      .split('\n').filter(file => file.endsWith('.ts') || (selection && file === selection.patch));
    const tracked = ['load/seed.ts', 'load/events.ts', 'load/compose.yml', 'load/channel-log.sql', 'load/slice5/stack.ts',
      'load/slice5/fixture.ts', 'load/slice5/judge.ts', 'load/pool-before-after-summary.ts',
      'load/harness-core/stages.ts', 'load/harness-core/host.ts', ...harnessFiles];
    save(join(output, selection ? 'DIAGNOSTIC-metadata.json' : 'metadata.json'), {
      // Formal metadata keeps its pre-diagnostic key order; a rehearsal says so first.
      ...(selection ? { mode: diagnosticMode, ...(p.rehearsal && { rehearsal: true, evidence: false }), sendTimingSampleEvery: 32,
        readTimingSampleEvery: selection.readTimingSampleEvery, readLanes: selection.readLanes, attribution, commit, image, k6, k6Id, project, plan: p }
        : { ...(p.rehearsal && { mode, evidence: false }), commit, image, k6, k6Id, project, plan: p,
          thresholds: { ...thresholds, moveP95Ms: moveLimits } }),
      orderedSteps,
      harnessCommit: command('git', ['-C', repo, 'rev-parse', 'HEAD']),
      harnessHashes: Object.fromEntries(tracked.map(file => [file, createHash('sha256').update(readFileSync(join(repo, file))).digest('hex')])),
      machine: { platform: platform(), arch: arch(), os: release(), cpu: cpus().length, memory: totalmem(), load: loadavg(), node: process.version },
      started: new Date().toISOString(),
      ...(headroom && { headroom }),
    });
    for (const step of orderedSteps) {
      abort.signal.throwIfAborted();
      const row: Result = { ...step, attempts: [] };
      results.push(row);
      for (;;) {
        const id = stepId(step) + (row.attempts.length ? '-rerun' : '');
        const labels = { [runLabel]: project, [stepLabel]: id };
        const dir = join(scratch, id);
        mkdirSync(dir, { mode: 0o700 });
        const attempt: Attempt = {};
        row.attempts.push(attempt);
        let stage = 'stack launch';
        let artifacts: object = {};
        let captured: Pick<Awaited<ReturnType<typeof generator>>, 'extra' | 'started'> | undefined;
        let stepCleaned = false, sampled = false;
        const startSampling = () => { stage = 'measurement'; sampled = true; run.startSampling(); };
        run.enter(selection ? `DIAGNOSTIC ${id}` : id);
        try {
          const stack = await startStack({ id, project, source: repo, image: image.id, privateDir: dir,
            burst: p.burst, refill: p.refill, labels, port: '0', diagnostic: Boolean(selection),
            appEnvironment: selection && readSampleEnvironment(selection.readTimingSampleEvery) });
          stage = 'app image check';
          if (docker('inspect', '--format', '{{.Image}}', stack.app) !== image.id) throw new Error('App image changed');
          stage = 'fixture';
          const seeded = await buildFixture(stack, p, step);
          stage = 'measurement setup';
          const measured = step.part === 'A' ? await latency(stack, seeded, p, abort.signal, startSampling)
            : step.part === 'F' ? await storage(stack, seeded, p, step, abort.signal, startSampling)
            : await generator(stack, seeded, p, step, dir, labels, k6, abort.signal, startSampling, Boolean(selection), selection?.readLanes);
          attempt.measurement = measured.measurement;
          if ('problem' in measured) attempt.problem = measured.problem;
          artifacts = measured;
          if (selection && 'extra' in measured && measured.extra) {
            captured = measured;
            const { app, k6: generator, postgres, containers } = measured.extra;
            const missing = [
              ...(!app?.byLane.send.phasesUs.before_admission ? ['send timings'] : []),
              ...(selection.sendBreakdown ? sendTimingProblems(app) : []),
              ...(selection.readTimingSampleEvery ? readTimingProblems(app?.byLane, selection.readLanes) : []),
              ...(!generator?.vus.some(point => point.active !== undefined && point.allocated !== undefined) ? ['k6 VU gauges'] : []),
              ...(!postgres.statementsAvailable ? ['PostgreSQL execution statistics'] : []),
              ...(!postgres.samples.length ? ['PostgreSQL wait samples'] : []),
              // A starved sampler (one query in flight) still yields samples; require half the window covered.
              ...(postgres.coveredMs < 500 * (step.part === 'E' ? p.replaySeconds : p.seconds) ? ['PostgreSQL wait sample coverage'] : []),
              // Log rotation can drop early events: the app must account for every 503 k6 saw on write lanes.
              ...(app && generator && app.writeUnavailable < generator.completed503.send + generator.completed503.move
                ? ['app 503 reasons (log incomplete)'] : []),
              ...Object.entries(containers.summary).filter(([, container]) => !container.samples).map(([name]) => name + ' cgroup samples'),
              ...(p.smoke && step.arm === 'move' && (!measured.measurement?.moveVerified || !app?.byLane.move.phasesUs.move_apply)
                ? ['verified Move and Move timings'] : []),
            ];
            if (missing.length) attempt.problem ??= 'Missing DIAGNOSTIC evidence (' + missing.join(', ') + ')';
          }
        } catch (error) {
          // SQL/Compose failures can embed disposable credentials in child-process errors.
          attempt.problem = `${stage} failed (${error instanceof Error ? error.name : 'unknown error'})`;
        } finally {
          if (!selection && attempt.problem && !abort.signal.aborted && await daemonUnavailable())
            attempt.infrastructure = infrastructureFailure;
          try { cleanup(project, id); stepCleaned = true; } catch { cleanupIssues.push(`${id}: step cleanup failed`); }
          if (selection) {
            const capture = captured?.extra;
            const arm = { mode: diagnosticMode, readLanes: selection.readLanes, attribution, step, problem: attempt.problem,
              started: captured?.started,
              workload: attempt.measurement && { ...attempt.measurement, mode: diagnosticMode }, server: capture?.app?.byLane };
            diagnosticArms.push(arm);
            save(join(output, `DIAGNOSTIC-${id}.json`), { ...arm, capture });
          } else {
            save(join(output, `${id}.json`), { step, ...artifacts, ...attempt });
          }
          rmSync(dir, { recursive: true, force: true });
        }
        if (!canRerun(attempt, rerun, p.smoke, abort.signal.aborted, sampled)) {
          if (!stepCleaned) throw new Error(`${id}: could not clean up this arm`);
          break;
        }
        rerun = true;
        // A failed daemon can leave a whole stack behind. Reclaim the run's
        // resources before starting another arm on the same host.
        for (let i = 0; i < 6 && await daemonUnavailable(); i++) await sleep(5000);
        abort.signal.throwIfAborted();
        cleanup(project);
      }
      run.done(stepId(step));
      if (remainingArmsSkipped(Boolean(selection), row.attempts[0]?.problem) && results.length < orderedSteps.length) {
        stoppedEarly = `${stepId(step)}: ${row.attempts[0]?.problem}`;
        console.log(`DIAGNOSTIC stopped after ${stepId(step)}: ${row.attempts[0]?.problem}`);
        break;
      }
      const invalid = results.length === 1 && results.length < orderedSteps.length ? firstArmInvalid(p, Boolean(selection), row) : [];
      if (invalid.length) {
        stoppedEarly = `${stepId(step)}: ${invalid.join('; ')}`;
        console.log(`Move harness stopped after the first arm ${stepId(step)}: INVALID (${invalid.join('; ')})`);
        break;
      }
    }
    complete = true;
  } finally {
    let cleaned = false;
    try { cleanup(project); cleaned = true; } catch { cleanupIssues.push('run cleanup failed'); }
    if (selection && image) {
      try { docker('image', 'rm', tag); } catch { cleanupIssues.push('DIAGNOSTIC image tag cleanup failed'); }
    }
    rmSync(scratch, { recursive: true, force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    const finished = complete && cleaned && !abort.signal.aborted;
    const allArms = finished && cleanupIssues.length === 0 && results.length === orderedSteps.length;
    const captured = allArms && results.every(result => !result.attempts[0]?.problem);
    const armProblem = results.some(row => row.attempts.at(-1)?.problem !== undefined);
    // Judge before status.json so its flags follow the verdict; a judge() error still reaches run.finish as a summary failure.
    let summary: { report: ReturnType<typeof render>; checks: ReturnType<typeof rehearsalChecks>; clean: boolean } | undefined;
    let summaryError: unknown;
    if (!selection) {
      try {
        const report = render(p, results, finished);
        const checks = p.rehearsal ? rehearsalChecks(p, results) : [];
        summary = { report, checks, clean: allArms && checks.every(check => !check.problems.length) };
      } catch (error) { summaryError = error; }
    }
    const passed = selection ? captured : summary !== undefined && finished
      && (p.rehearsal ? summary.clean : p.smoke ? summary.report.verdict.functional === 'PASS' : summary.report.verdict.overall === 'PASS');
    let line = '';
    const status = run.finish(() => {
      if (selection) {
        save(join(output, 'DIAGNOSTIC-results.json'), { mode: diagnosticMode, ...(p.rehearsal && { rehearsal: true, evidence: false }),
          readLanes: selection.readLanes, attribution, complete: captured, cleanupIssues, arms: diagnosticArms,
          skipped: orderedSteps.slice(results.length).map(stepId) });
        line = `DIAGNOSTIC ${p.rehearsal ? 'REHEARSAL ' : ''}capture ${captured ? 'complete' : 'incomplete'}` + (attribution ? ` · ${attribution}` : '')
          + (p.rehearsal ? ' (never evidence)' : '');
      } else {
        if (!summary) throw summaryError;
        const { report, checks, clean } = summary;
        save(join(output, 'results.json'), { ...(p.rehearsal && { mode, evidence: false, rehearsalClean: clean, checks }),
          ...scheduledWork(finished, orderedSteps, results.length), ...(stoppedEarly === undefined ? {} : { stoppedEarly }),
          cleanupIssues, results, ...report.verdict });
        writeFileSync(join(output, 'report.md'), report.markdown, { mode: 0o600 });
        line = p.rehearsal ? `Move harness REHEARSAL ${clean ? 'clean' : 'not clean'} (never evidence)`
          : `Move harness ${p.smoke ? 'functional ' + report.verdict.functional : report.verdict.overall}`;
      }
    }, { ...statusFlags({ passed, finished, cleanupIssues: cleanupIssues.length, stoppedEarly: stoppedEarly !== undefined, armProblem,
      diagnosticIncomplete: Boolean(selection) && !captured, verdict: summary?.report.verdict }),
    interrupted: abort.signal.aborted, summaryInvalidates: true });
    if (line) console.log(line);
    console.log(`Move harness status ${status.outcome} (${mode}, evidence ${status.evidence})`);
    if (!passed || status.summaryFailed) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const safe = error instanceof Error && !('stderr' in error) ? error.message : 'A required command failed';
    console.error(safe);
    process.exitCode = 1;
  });
}
