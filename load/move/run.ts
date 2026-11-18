import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { buildFixture, committedMoves, head, type Seeded } from './fixture.ts';
import { infrastructureFailure, type Attempt, type Measurement, type Result } from './judge.ts';
import { latency, storage } from './measure.ts';
import { moveLimits, plan, stepId, steps, thresholds, type Plan, type Step } from './plan.ts';
import { render } from './report.ts';
import { command, docker, sampler, sleep, startStack, type Stack } from '../slice5/stack.ts';

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

export function canRerun(attempt: Attempt, used: boolean, smoke: boolean, aborted: boolean) {
  return attempt.infrastructure === infrastructureFailure && !used && !smoke && !aborted;
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

async function generator(stack: Stack, seeded: Seeded, p: Plan, step: Step, dir: string, labels: Record<string, string>, k6: string, signal: AbortSignal) {
  save(join(dir, 'data.json'), seeded.data);
  save(join(dir, 'tokens.json'), seeded.tokens);
  const name = `${stack.env.LOAD_PROJECT}-k6`;
  const generatorArgs = ['run', '--rm', '--name', name, '--network', stack.network, '--ulimit', 'nofile=65536:65536',
    '--user', `${process.getuid!()}:${process.getgid!()}`, '--cap-drop', 'ALL',
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    '-v', `${repo}:/work:ro`, '-v', `${dir}:/fixture:ro`, '-w', '/work',
    '-e', 'BASE_URL=http://app:8080', '-e', 'REQUEST_TIMEOUT_SECONDS=10', '-e', `MOVE_STEP=${JSON.stringify(step)}`,
    '-e', `MOVE_SMOKE=${Number(p.smoke)}`, k6, 'run', '--quiet', 'load/move/workload-k6.ts'];
  const prior = head(stack, seeded.data);
  const resources = sampler(stack, () => name);
  const seconds = step.part === 'E' ? p.replaySeconds : p.seconds;
  let stdout = '';
  let problem: string | undefined;
  let diagnostic: string | undefined;
  try {
    const result = await exec('docker', generatorArgs, { signal, timeout: (seconds + 2 * p.drain + 30) * 1000 });
    stdout = result.stdout;
  } catch (error) {
    const exit = error as { code?: number | string; stdout?: string; stderr?: string };
    stdout = exit.stdout ?? '';
    problem = `k6 did not complete successfully (exit ${exit.code ?? 'unknown'})`;
    const first = exit.stderr?.match(/(?:^|\s)msg="([^"]{1,180})"/)?.[1];
    // Keep source/error class clues without any request values or fixture data.
    if (first?.includes('workload-k6.ts') && /ReferenceError|TypeError|SyntaxError/.test(first))
      diagnostic = first.split(/ReferenceError|TypeError|SyntaxError/)[0].slice(0, 100);
  } finally {
    await resources.stop();
  }
  const line = stdout.split('\n').find(l => l.startsWith('MOVE_RESULT '));
  if (!line) return { problem: problem ?? 'Missing k6 summary', diagnostic, samples: resources.samples };
  const raw = JSON.parse(line.slice('MOVE_RESULT '.length)) as Pick<Measurement, 'lanes' | 'topicReaders'> & { started?: number };
  const evidence = raw.started ? resources.window(raw.started, raw.started + seconds * 1000) : undefined;
  const measurement: Measurement = { lanes: raw.lanes, topicReaders: raw.topicReaders, evidence: evidence?.evidence };
  if (step.arm === 'move' && step.part !== 'E') {
    const committed = committedMoves(stack, seeded.data, prior);
    measurement.moveVerified = committed > 0 && committed === raw.lanes.move?.accepted;
  }
  return { measurement, problem, diagnostic, samples: resources.samples, cpu: evidence?.cpu, started: raw.started };
}

async function main() {
  const { values } = parseArgs({ options: { commit: { type: 'string' }, image: { type: 'string' },
    out: { type: 'string' }, smoke: { type: 'boolean' } } });
  if (!values.commit || !values.out || !values.image)
    throw new Error('Usage: node load/move/run.ts --commit FULL_SHA --image IMAGE --out NEW_DIRECTORY [--smoke]');
  const commit = values.commit, p = plan(values.smoke ?? false);
  const image = JSON.parse(docker('image', 'inspect', '--format',
    `{"id":{{json .Id}},"revision":{{json (index .Config.Labels "${revisionLabel}")}}}`, values.image)) as { id: string; revision: string };
  checkImageRevision(commit, image.revision);
  if (command('git', ['-C', repo, 'rev-parse', '--verify', commit + '^{commit}']) !== commit) throw new Error('Commit is unavailable locally');
  if (!p.smoke) {
    if (platform() !== 'darwin') throw new Error('Formal Move measurement requires a Mac');
    command('git', ['-C', repo, 'merge-base', '--is-ancestor', commit, 'origin/main']);
  }
  const k6 = command('make', ['-s', '-C', repo, 'load-image']);
  const k6Id = docker('image', 'inspect', '--format', '{{.Id}}', k6);
  const output = resolve(values.out);
  mkdirSync(output, { mode: 0o700 });
  const project = `fukulow-move-${randomUUID()}`;
  const scratch = mkdtempSync(join(platform() === 'darwin' ? '/private/tmp' : tmpdir(), 'fukulow-move-'));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const results: Result[] = [];
  let rerun = false, complete = false;
  const cleanupIssues: string[] = [];
  try {
    const harnessFiles = command('git', ['-C', repo, 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'load/move'])
      .split('\n').filter(file => file.endsWith('.ts'));
    const tracked = ['load/seed.ts', 'load/events.ts', 'load/compose.yml', 'load/channel-log.sql', 'load/slice5/stack.ts',
      'load/slice5/fixture.ts', 'load/slice5/judge.ts', 'load/pool-before-after-summary.ts', ...harnessFiles];
    save(join(output, 'metadata.json'), {
      commit, image, k6, k6Id, project, plan: p, thresholds: { ...thresholds, moveP95Ms: moveLimits }, orderedSteps: steps(p),
      harnessCommit: command('git', ['-C', repo, 'rev-parse', 'HEAD']),
      harnessHashes: Object.fromEntries(tracked.map(file => [file, createHash('sha256').update(readFileSync(join(repo, file))).digest('hex')])),
      machine: { platform: platform(), arch: arch(), os: release(), cpu: cpus().length, memory: totalmem(), load: loadavg(), node: process.version },
      started: new Date().toISOString(),
    });
    for (const step of steps(p)) {
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
        let stepCleaned = false;
        console.log(id);
        try {
          const stack = await startStack({ id, project, source: repo, image: image.id, privateDir: dir,
            burst: p.burst, refill: p.refill, labels, port: '0' });
          stage = 'app image check';
          if (docker('inspect', '--format', '{{.Image}}', stack.app) !== image.id) throw new Error('App image changed');
          stage = 'fixture';
          const seeded = await buildFixture(stack, p, step);
          stage = 'measurement';
          const measured = step.part === 'A' ? await latency(stack, seeded, p, abort.signal)
            : step.part === 'F' ? await storage(stack, seeded, p, step, abort.signal)
            : await generator(stack, seeded, p, step, dir, labels, k6, abort.signal);
          attempt.measurement = measured.measurement;
          if ('problem' in measured) attempt.problem = measured.problem;
          artifacts = measured;
        } catch (error) {
          // SQL/Compose failures can embed disposable credentials in child-process errors.
          attempt.problem = `${stage} failed (${error instanceof Error ? error.name : 'unknown error'})`;
        } finally {
          if (attempt.problem && !abort.signal.aborted && await daemonUnavailable())
            attempt.infrastructure = infrastructureFailure;
          try { cleanup(project, id); stepCleaned = true; } catch { cleanupIssues.push(`${id}: step cleanup failed`); }
          save(join(output, `${id}.json`), { step, ...artifacts, ...attempt });
          rmSync(dir, { recursive: true, force: true });
        }
        if (!canRerun(attempt, rerun, p.smoke, abort.signal.aborted)) {
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
    }
    complete = true;
  } finally {
    let cleaned = false;
    try { cleanup(project); cleaned = true; } catch { cleanupIssues.push('run cleanup failed'); }
    rmSync(scratch, { recursive: true, force: true });
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    const finished = complete && cleaned && !abort.signal.aborted;
    const report = render(p, results, finished);
    save(join(output, 'results.json'), { complete: finished, cleanupIssues, results, ...report.verdict });
    writeFileSync(join(output, 'report.md'), report.markdown, { mode: 0o600 });
    console.log(`Move harness ${p.smoke ? 'functional ' + report.verdict.functional : report.verdict.overall}`);
    if (!finished || (p.smoke ? report.verdict.functional !== 'PASS' : report.verdict.overall !== 'PASS')) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const safe = error instanceof Error && !('stderr' in error) ? error.message : 'A required command failed';
    console.error(safe);
    process.exitCode = 1;
  });
}
