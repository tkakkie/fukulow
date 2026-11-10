import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

function fixture(t: { after: (callback: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'fukulow-backup-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const log = join(root, 'calls')
  writeFileSync(join(bin, 'docker'), String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG, JSON.stringify(args) + '\n');
if (process.env.DATABASE_URL) process.exit(91);
if (args[0] === 'compose') {
  const files = fs.readdirSync(process.env.TEST_DIRECTORY);
  if (files.some(name => name !== 'previous.dump' && !name.startsWith('.partial-'))) process.exit(92);
}
if (args.includes('--version')) {
  console.log('pg_dump (PostgreSQL) ' + (process.env.TEST_FAIL === 'version' ? '17.6' : '18.6'));
} else if (args.includes('pg_dump')) {
  process.stdout.write('archive-data');
  if (process.env.TEST_FAIL === 'dump') { console.error('SECRET_SENTINEL'); process.exit(1); }
  if (process.env.TEST_FAIL === 'signal') process.kill(process.pid, 'SIGTERM');
} else if (args.includes('pg_restore')) {
  fs.readFileSync(0);
  if ((args.includes('--list') && process.env.TEST_FAIL === 'list') ||
      (args.includes('--single-transaction') && process.env.TEST_FAIL === 'restore')) {
    console.error('SECRET_SENTINEL'); process.exit(1);
  }
} else if (args.includes('/proc/1/comm')) console.log('postgres');
else if ((args.includes('psql') && process.env.TEST_FAIL === 'sessions') ||
         (args.includes('pg_amcheck') && process.env.TEST_FAIL === 'integrity')) {
  console.error('SECRET_SENTINEL'); process.exit(1);
}
`, { mode: 0o700 })
  const run = (script: string, destination: string, fail = '') => spawnSync(process.execPath,
    [fileURLToPath(new URL(script, import.meta.url)), destination], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_FAIL: fail,
        TEST_DIRECTORY: destination, DATABASE_URL: 'postgres://SECRET_SENTINEL@invalid/secret' },
    })
  const calls = (): string[][] => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { root, log, run, calls }
}

test('backup publishes a private verified archive and preserves older backups', t => {
  const { root, run, calls } = fixture(t)
  const directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, 'previous.dump'), 'previous', { mode: 0o600 })
  const result = run('./backup.ts', directory)
  assert.equal(result.status, 0, result.stderr)
  const artifact = result.stdout.trim()
  assert.match(artifact, /fukulow-.*\.dump$/)
  assert.equal(statSync(artifact).mode & 0o777, 0o600)
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  assert.equal(readFileSync(artifact, 'utf8'), 'archive-data')
  assert.equal(readFileSync(join(directory, 'previous.dump'), 'utf8'), 'previous')
  assert.equal(readdirSync(directory).length, 2)
  assert.deepEqual(calls().map(args => args.at(-1)), ['--version', '--format=custom', '--list'])
})

for (const failure of ['version', 'dump', 'signal', 'list']) {
  test(`backup ${failure} failure never publishes partial data or leaks diagnostics`, t => {
    const { root, run } = fixture(t)
    const directory = join(root, 'backups')
    mkdirSync(directory, { mode: 0o700 })
    writeFileSync(join(directory, 'previous.dump'), 'previous')
    const result = run('./backup.ts', directory, failure)
    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET_SENTINEL/)
    assert.deepEqual(readdirSync(directory), ['previous.dump'])
    assert.equal(readFileSync(join(directory, 'previous.dump'), 'utf8'), 'previous')
  })
}

test('backup refuses permissive directories and symlinks', t => {
  const { root, run } = fixture(t)
  const directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  chmodSync(directory, 0o755)
  assert.equal(run('./backup.ts', directory).status, 1)
  chmodSync(directory, 0o700)
  const link = join(root, 'link')
  symlinkSync(directory, link)
  assert.equal(run('./backup.ts', link).status, 1)
  assert.deepEqual(readdirSync(directory), [])
})

for (const failure of ['', 'list', 'restore', 'sessions', 'integrity']) {
  test(`restore drill isolates its target and cleans up on ${failure || 'success'}`, t => {
    const { root, run, calls } = fixture(t)
    const archive = join(root, 'backup.dump')
    writeFileSync(archive, 'archive')
    const result = run('./restore-drill.ts', archive, failure)
    assert.equal(result.status, failure ? 1 : 0, result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET_SENTINEL/)
    const commands = calls()
    const create = commands[0]
    const name = create[create.indexOf('--name') + 1]
    assert.match(name, /^fukulow-restore-drill-/)
    assert.ok(create.includes('--tmpfs'))
    assert.equal(create[create.indexOf('--network') + 1], 'none')
    assert.equal(create.at(-1), 'postgres:18')
    assert.ok(!create.some(arg => ['-p', '--publish', '-v', '--volume'].includes(arg)))
    assert.ok(commands.slice(1, -1).every(args => args[0] === 'exec' && args[2] === name))
    assert.deepEqual(commands.at(-1), ['rm', '-f', '-v', name])
    assert.equal(readFileSync(archive, 'utf8'), 'archive')
  })
}
