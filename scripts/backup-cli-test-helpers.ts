import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

export function fixture(t: { after: (callback: () => void) => void }) {
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
  if (args[1] !== '-f' || args[2] !== process.env.TEST_COMPOSE_FILE ||
      fs.realpathSync(process.cwd()) !== fs.realpathSync(require('node:path').dirname(args[2]))) process.exit(93);
  const files = fs.readdirSync(process.env.TEST_DIRECTORY);
  if (!process.env.TEST_ALLOW_FINAL && files.some(name => name !== 'previous.dump' && name !== '.backup-run.lock' && !name.startsWith('.partial-'))) process.exit(92);
}
if (args[0] === 'run' && process.env.TEST_FAIL === 'start') { console.error('SECRET_SENTINEL'); process.exit(1); }
if (args[0] === 'rm' && process.env.TEST_FAIL === 'cleanup') { console.error('SECRET_SENTINEL'); process.exit(1); }
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
  const run = (script: string, destination: string, fail = '', extraEnv: Record<string, string> = {}) => spawnSync(process.execPath,
    [fileURLToPath(new URL(script, import.meta.url)), destination], {
      encoding: 'utf8',
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_LOG: log, TEST_FAIL: fail,
        TEST_DIRECTORY: destination, TEST_COMPOSE_FILE: join(repositoryRoot, 'compose.yml'),
        DATABASE_URL: 'postgres://SECRET_SENTINEL@invalid/secret', ...extraEnv },
    })
  const calls = (): string[][] => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  return { root, log, run, calls }
}
