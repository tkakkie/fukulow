import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

const archive = 'fixture archive $private.dump'
const archiveData = 'fixture-backup-data'
const databaseUrl = 'postgres://fixture-owner-password@invalid.example/fukulow'
const credentials = { POSTGRES_PASSWORD: 'fixture-postgres-password', AGE_IDENTITY: 'fixture-age-identity',
  R2_SECRET_ACCESS_KEY: 'fixture-r2-key' }
const stdoutSecret = 'fixture-stdout-only'
const stderrSecret = 'fixture-stderr-only'
const repository = fileURLToPath(new URL('../', import.meta.url))

const dockerStub = String.raw`#!/usr/bin/env node
const assert = require('node:assert/strict');
const { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync, writeSync } = require('node:fs');
const args = process.argv.slice(2);
assert.equal(process.env.DATABASE_URL, undefined);
assert.equal(process.cwd(), realpathSync(${JSON.stringify(repository)}));
const command = args[3];
const stage = args[0] === 'run' ? 'start' : args[0] === 'rm' ? 'cleanup'
  : command === 'pg_restore' ? (args.includes('--list') ? 'list' : 'restore')
  : command === 'psql' ? 'sessions' : command === 'pg_amcheck' ? 'integrity' : 'ready';
let input = '';
if (command === 'pg_restore') {
  input = readFileSync(0, 'utf8');
  assert.equal(input, ${JSON.stringify(archiveData)});
  assert.deepEqual(args.slice(4), stage === 'list' ? ['--list'] : [
    '-U', 'fukulow', '-d', 'fukulow', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl',
  ]);
}
if (command === 'psql') {
  input = readFileSync(0, 'utf8');
  assert.equal(input, readFileSync('server/src/auth/end-all-sessions.sql', 'utf8'));
  assert.deepEqual(args.slice(4), ['-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow']);
}
if (command === 'pg_amcheck') {
  assert.deepEqual(args.slice(4), ['-U', 'fukulow', '-d', 'fukulow', '--install-missing', '--heapallindexed']);
}
const failOnce = process.env.TEST_FAIL_ONCE === command && process.env.TEST_EMITTED && !existsSync(process.env.TEST_EMITTED);
if (stage === process.env.TEST_STAGE || failOnce) {
  const privateValues = [input, ${JSON.stringify(archive)},
    ...${JSON.stringify(Object.keys(credentials))}.map(name => process.env[name])].join('\n');
  writeSync(1, privateValues + ${JSON.stringify(stdoutSecret)});
  writeSync(2, privateValues + ${JSON.stringify(stderrSecret)});
  writeFileSync(process.env.TEST_EMITTED, '');
  if (process.env.TEST_MODE === 'timeout') setTimeout(() => { process.exitCode = 43 }, 2500);
  else process.exitCode = 42;
} else {
  if (process.env.TEST_STDERR) writeSync(2, ${JSON.stringify(stderrSecret)});
  if (process.env.TEST_NOISY || stage === 'list') {
    const output = Buffer.alloc(1024 * 1024 + 1, 'x');
    if (command !== 'cat') process.stdout.write(output);
    process.stderr.write(output);
  }
  if (command === 'cat') {
    const log = process.env.TEST_PID_LOG;
    let pid = 'postgres';
    if (log) {
      const attempts = existsSync(log) ? readFileSync(log, 'utf8').split('\n').length - 1 : 0;
      pid = ['sh', 'postgres-temp'][attempts] ?? pid;
      appendFileSync(log, pid + '\n');
    }
    console.log(pid);
  }
}
`

const caller = `
  import childProcess from 'node:child_process';
  import fs, { writeSync } from 'node:fs';
  import { syncBuiltinESMExports } from 'node:module';
  import { inspect } from 'node:util';
  import { restoreDrill } from ${JSON.stringify(new URL('./restore-drill.ts', import.meta.url).href)};

  // Set a test deadline at the process boundary and record how the child terminated.
  const spawnSync = childProcess.spawnSync;
  let termination;
  childProcess.spawnSync = (command, args, options) => {
    const timeout = process.env.TEST_MODE === 'timeout' ? 1000 : undefined;
    const result = spawnSync(command, args, { ...options, timeout });
    if (result.error || result.status !== 0) termination = result.error?.code ?? result.status;
    return result;
  };
  if (process.env.TEST_REMOVE_ARCHIVE_AFTER_ACCESS) {
    const accessSync = fs.accessSync;
    fs.accessSync = (path, mode) => {
      accessSync(path, mode);
      if (path === process.argv[1]) fs.unlinkSync(path);
    };
  }
  syncBuiltinESMExports();
  try {
    restoreDrill(process.argv[1]);
  } catch (error) {
    writeSync(3, JSON.stringify({ termination, message: error.message, error: inspect(error, { showHidden: true, depth: null }) }));
    process.exitCode = 1;
  }
`

function drillFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-drill-leaks-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'docker'), dockerStub, { mode: 0o700 })
  const run = (env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--input-type=module', '--eval', caller, archive], {
    cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 5000,
    env: { PATH: [directory, dirname(process.execPath)].join(delimiter), ...credentials,
      DATABASE_URL: databaseUrl, ...env },
  })
  return { directory, run }
}

for (const stage of ['start', 'list', 'restore', 'sessions', 'integrity', 'cleanup']) {
  for (const mode of ['failure', 'timeout']) {
    test(`restore drill suppresses ${stage} secrets on ${mode}`, t => {
      const { directory, run } = drillFixture(t)
      writeFileSync(join(directory, archive), archiveData)
      const emitted = join(directory, 'emitted')
      const result = run({ TEST_STAGE: stage, TEST_MODE: mode, TEST_EMITTED: emitted })

      assert.equal(result.error, undefined)
      assert.equal(result.status, 1)
      const report = result.output[3]
      assert.ok(report)
      const { termination, message, error } = JSON.parse(report)
      const secrets = [archive, archiveData, databaseUrl, ...Object.values(credentials), stdoutSecret, stderrSecret]
      for (const [channel, output] of [['error', error], ['stdout', result.stdout], ['stderr', result.stderr]]) {
        for (const secret of secrets) assert.ok(!output.includes(secret), `${channel} leaks a private value`)
      }
      assert.equal(message, `stage=${stage} category=operation`)
      assert.equal(termination, mode === 'timeout' ? 'ETIMEDOUT' : 42)
      assert.ok(existsSync(emitted), 'the stub emitted diagnostics before terminating')
      assert.equal(result.stderr, '')
      if (stage === 'cleanup') assert.match(result.stdout, /^Restore drill passed in /)
      else assert.equal(result.stdout, '')
    })
  }
}

for (const category of ['missing', 'permission', 'operation']) {
  const skip = category === 'permission' && process.getuid?.() === 0 && 'root can read mode-000 files'
  const name = category === 'operation' ? 'restore drill reports an operation error when the archive disappears after access'
    : `restore drill reports a ${category} archive failure at list`
  test(name, { skip }, t => {
    const { directory, run } = drillFixture(t)
    if (category === 'permission') writeFileSync(join(directory, archive), archiveData, { mode: 0o000 })
    if (category === 'operation') writeFileSync(join(directory, archive), archiveData)

    const result = run(category === 'operation' ? { TEST_REMOVE_ARCHIVE_AFTER_ACCESS: '1' } : {})

    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    const report = result.output[3]
    assert.ok(report)
    const { termination, message, error } = JSON.parse(report)
    assert.equal(termination, undefined, 'Node rejects the archive before launching pg_restore')
    assert.equal(message, `stage=list category=${category}`)
    assert.ok(!error.includes(archive), 'the archive path stays private')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  })
}

for (const command of ['pg_isready', 'cat']) {
  test(`restore drill suppresses stderr when ${command} fails during readiness`, t => {
    const { directory, run } = drillFixture(t)
    writeFileSync(join(directory, archive), archiveData)
    const emitted = join(directory, 'emitted')

    const result = run({ TEST_FAIL_ONCE: command, TEST_EMITTED: emitted })

    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.output[3] ?? '')
    assert.ok(existsSync(emitted), 'the stub emitted diagnostics before retry')
    assert.match(result.stdout, /^Restore drill passed in [^\n]+\n$/)
    assert.equal(result.stderr, '')
  })
}

test('restore drill suppresses stderr from successful Docker calls', t => {
  const { directory, run } = drillFixture(t)
  writeFileSync(join(directory, archive), archiveData)

  const result = run({ TEST_STDERR: '1' })

  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.output[3] ?? '')
  assert.match(result.stdout, /^Restore drill passed in [^\n]+\n$/)
  assert.equal(result.stderr, '')
})

test('restore drill keeps the PostgreSQL flags and suppresses large successful output', t => {
  const { directory, run } = drillFixture(t)
  writeFileSync(join(directory, archive), archiveData)

  const result = run({ TEST_NOISY: '1' })

  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.output[3] ?? '')
  assert.match(result.stdout, /^Restore drill passed in [^\n]+\n$/)
  assert.equal(result.stderr.length, 0)
})

test('restore drill waits for postgres to be PID 1', t => {
  const { directory, run } = drillFixture(t)
  writeFileSync(join(directory, archive), archiveData)
  const pidLog = join(directory, 'pid-log')

  const result = run({ TEST_PID_LOG: pidLog })

  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.output[3] ?? '')
  assert.equal(readFileSync(pidLog, 'utf8'), 'sh\npostgres-temp\npostgres\n')
})
