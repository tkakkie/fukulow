import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
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
const { readFileSync, realpathSync, writeFileSync, writeSync } = require('node:fs');
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
}
if (command === 'psql') {
  input = readFileSync(0, 'utf8');
  assert.equal(input, readFileSync('server/src/auth/end-all-sessions.sql', 'utf8'));
  assert.deepEqual(args.slice(4), ['-X', '-v', 'ON_ERROR_STOP=1', '-U', 'fukulow', '-d', 'fukulow']);
}
if (stage === process.env.TEST_STAGE) {
  const privateValues = [input, ${JSON.stringify(archive)},
    ...${JSON.stringify(Object.keys(credentials))}.map(name => process.env[name])].join('\n');
  writeSync(1, privateValues + ${JSON.stringify(stdoutSecret)});
  writeSync(2, privateValues + ${JSON.stringify(stderrSecret)});
  writeFileSync(process.env.TEST_EMITTED, '');
  if (process.env.TEST_MODE === 'timeout') setTimeout(() => { process.exitCode = 43 }, 2500);
  else process.exitCode = 42;
} else if (command === 'cat') {
  console.log('postgres');
} else if (stage === 'list') {
  writeSync(1, Buffer.alloc(1024 * 1024 + 1, 'x'));
}
`

const caller = `
  import childProcess from 'node:child_process';
  import { writeSync } from 'node:fs';
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
  syncBuiltinESMExports();
  try {
    restoreDrill(process.argv[1]);
  } catch (error) {
    writeSync(3, JSON.stringify({ termination, message: error.message, error: inspect(error, { showHidden: true, depth: null }) }));
    process.exitCode = 1;
  }
`

for (const stage of ['start', 'list', 'restore', 'sessions', 'integrity', 'cleanup']) {
  for (const mode of ['failure', 'timeout']) {
    test(`restore drill suppresses ${stage} secrets on ${mode}`, t => {
      const directory = mkdtempSync(join(tmpdir(), 'fukulow-drill-leaks-'))
      t.after(() => rmSync(directory, { recursive: true, force: true }))
      writeFileSync(join(directory, 'docker'), dockerStub, { mode: 0o700 })
      writeFileSync(join(directory, archive), archiveData)
      const emitted = join(directory, 'emitted')
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', caller, archive], {
        cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 5000,
        env: { PATH: [directory, dirname(process.execPath)].join(delimiter), ...credentials,
          DATABASE_URL: databaseUrl, TEST_STAGE: stage, TEST_MODE: mode, TEST_EMITTED: emitted },
      })

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
