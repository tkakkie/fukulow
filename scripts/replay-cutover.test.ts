import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./replay-cutover.ts', import.meta.url));
const fixtureSQL = 'INSERT INTO organizations (organization_id, name)';
const phaseSQL = "SELECT 'swap_and_protect', round(";
const stdoutMarker = 'psql-test-stdout';
const stderrMarker = 'docker-test-stderr';
const phaseRows = 'lock|0.101\nvalidate|0.202\ncopy|0.303\nindex_and_constraints|0.404\nswap_and_protect|0.505\ncommit|0.606';

const dockerStub = String.raw`#!/usr/bin/env node
const assert = require('node:assert/strict');
const { appendFileSync, readFileSync, writeSync } = require('node:fs');
const args = process.argv.slice(2);
const command = args[0] === 'exec' ? args[3] : args[0];
let stage = command;
let input = '';
if (command === 'psql') {
  input = readFileSync(0, 'utf8');
  // These options determine the quiet, unaligned, tuples-only report and stop on SQL errors.
  assert.ok(args.includes('-XqAt') || (args.includes('-X') && args.includes('-qAt')));
  assert.equal(args[args.indexOf('-v') + 1], 'ON_ERROR_STOP=1');
  if (input.includes(${JSON.stringify(fixtureSQL)})) stage = 'fixture';
  else if (input.includes(${JSON.stringify(phaseSQL)})) stage = 'phases';
  else if (input.startsWith('SELECT (SELECT count(*) FROM messages)')) stage = 'counts';
}
const retry = command === 'pg_isready' && !readFileSync('calls', 'utf8').includes('pg_isready\n');
appendFileSync('calls', stage + '\n');
if (stage === process.env.CUTOVER_FAIL_STAGE || retry) {
  const output = stage === 'phases' ? ${JSON.stringify(phaseRows)} : ${JSON.stringify(stdoutMarker)};
  writeSync(1, input + '\n' + output);
  writeSync(2, input + '\n' + ${JSON.stringify(stderrMarker)});
  appendFileSync('calls', stage + ':emitted\n');
  if (process.env.CUTOVER_FAIL_MODE === 'timeout' && !retry) setTimeout(() => {}, 4000);
  else process.exitCode = 42;
} else {
  if (command === 'pg_isready') writeSync(2, ${JSON.stringify(stderrMarker)});
  else if (!process.env.CUTOVER_FAIL_STAGE) writeSync(2, stage + ' notice\n');
  if (stage === 'phases') writeSync(1, '\n' + ${JSON.stringify(phaseRows)} + '\n\n');
  else if (stage === 'counts') writeSync(1, '6|2\n');
  else writeSync(1, ${JSON.stringify(stdoutMarker)});
}
`;

const preload = `
  import childProcess from 'node:child_process';
  import { writeSync } from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  import { inspect } from 'node:util';

  let ticks = 0;
  Object.defineProperty(performance, 'now', { value: () => ticks++ });
  let termination;
  if (process.env.CUTOVER_FAIL_MODE === 'timeout') {
    // Inject a deadline only for the fixture query so full-scale runs keep their existing limits.
    const spawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => {
      if (command !== 'docker' || !options?.input?.includes(${JSON.stringify(fixtureSQL)})) {
        return spawnSync(command, args, options);
      }
      const result = spawnSync(command, args, { ...options, timeout: 1000 });
      termination = result.error?.code ?? result.status;
      return result;
    };
    syncBuiltinESMExports();
  }
  process.setUncaughtExceptionCaptureCallback(error => {
    writeSync(3, JSON.stringify({ termination, thrown: inspect(error, { showHidden: true, depth: null }) }));
    process.exitCode = 1;
  });
`;
const preloadURL = `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`;

function invoke(t: TestContext, stage?: string, mode?: 'failure' | 'timeout') {
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-replay-cutover-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'docker'), dockerStub, { mode: 0o700 });
  const result = spawnSync(process.execPath, ['--import', preloadURL, script, 'rehearse', '2', '3', '4'], {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 8000,
    env: { PATH: [directory, dirname(process.execPath)].join(delimiter), CUTOVER_FAIL_STAGE: stage, CUTOVER_FAIL_MODE: mode },
  });
  assert.equal(result.error, undefined);
  return { ...result, calls: readFileSync(join(directory, 'calls'), 'utf8') };
}

test('replay cutover retries readiness silently and prints the existing timing report', t => {
  const result = invoke(t);
  assert.equal(result.status, 0, result.output[3] ?? '');
  assert.equal(result.stderr, ['run', 'psql', 'fixture', 'pg_dump', 'psql', 'phases', 'psql', 'counts', 'rm']
    .map(stage => `${stage} notice\n`).join(''));
  assert.equal(result.stdout, [
    'old_schema|1.000',
    'fixture|1.000',
    'backup|1.000',
    'standalone_validation|1.000',
    phaseRows,
    'postcutover_validation|1.000',
    'PASS |2 Channels|4 Members|6|2 (Messages|mutations). Timings in ms.',
    '',
  ].join('\n'));
  assert.match(result.calls, /^run\npg_isready\npg_isready:emitted\npg_isready\npsql\n/);
});

for (const stage of ['run', 'fixture', 'pg_dump', 'phases', 'rm']) {
  for (const mode of stage === 'fixture' ? ['failure', 'timeout'] as const : ['failure'] as const) {
    test(`replay cutover suppresses ${stage} diagnostics on ${mode}`, t => {
      const result = invoke(t, stage, mode);
      assert.equal(result.status, 1);
      assert.ok(result.calls.includes(`${stage}:emitted\n`));
      const report = result.output[3];
      assert.ok(report);
      const { termination, thrown } = JSON.parse(report);
      if (mode === 'timeout') assert.equal(termination, 'ETIMEDOUT');
      const diagnostics = [fixtureSQL, phaseSQL, stdoutMarker, stderrMarker, 'fukulow-620-rehearsal-'];
      if (stage !== 'rm') diagnostics.push(phaseRows);
      for (const [stream, output] of [['error', thrown], ['stdout', result.stdout], ['stderr', result.stderr]]) {
        for (const value of diagnostics) assert.ok(!output.includes(value), `${stream} echoes Docker diagnostics`);
      }
      assert.match(thrown, mode === 'timeout' ? /^Error: Command failed to complete\n/ : /^Error: Command exited with status 42\n/);
      assert.equal(result.stderr, '');
    });
  }
}
