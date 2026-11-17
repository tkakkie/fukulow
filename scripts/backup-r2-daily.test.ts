import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { backupSchedule, dailyBackup, recheckNewest } from './backup-r2.ts'
import { runDaily } from './backup-r2-daily.ts'
import { fakeS3 } from './backup-r2-fake.ts'

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'daily-wiring-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const configFile = join(directory, 'config'), recipientFile = join(directory, 'recipient')
  writeFileSync(recipientFile, 'test-public-recipient', { mode: 0o600 })
  writeFileSync(configFile, JSON.stringify({ directory, recipientFile, curlConfigFile: join(directory, 'curl'),
    baseUrl: 'https://backup.invalid/', notifierConfigFile: join(directory, 'notify') }), { mode: 0o600 })
  return { directory, configFile }
}
test('daily VPS wiring holds the local lock through backup and final readback', async t => {
  const { directory, configFile } = fixture(t), now = Date.now()
  const fake = await fakeS3(() => now); t.after(fake.close)
  const source = join(directory, 'source'); writeFileSync(source, 'dump')
  let checked = false
  const events: string[] = []
  await runDaily(configFile, {
    runner: async () => fake.runner('backups'), notifier: async () => async event => { events.push(event) },
    now: () => now,
    daily: options => dailyBackup({ ...options, dump: (_d, capture) => { capture(); return source },
      encrypt: (_s, target) => writeFileSync(target, 'cipher') }),
    recheck: async (bucket, at) => {
      assert.ok(existsSync(join(directory, '.backup-run.lock')))
      checked = true; return recheckNewest(bucket, at)
    },
  })
  assert.ok(checked); assert.ok(!existsSync(join(directory, '.backup-run.lock')))
  assert.deepEqual(events, ['daily-readback-failed']) // first backup has no predecessor
})
test('daily VPS failures notify once and release locks with safe diagnostics', async t => {
  for (const failure of ['runner', 'dump', 'readback', 'local', 'local-release']) {
    const { directory, configFile } = fixture(t), fake = await fakeS3(Date.now); t.after(fake.close)
    const events: string[] = []
    if (failure === 'local') writeFileSync(join(directory, '.backup-run.lock'), '')
    await assert.rejects(runDaily(configFile, {
      runner: async () => { if (failure === 'runner') throw new Error('PRIVATE_SENTINEL'); return fake.runner('backups') },
      notifier: async () => async event => { events.push(event) },
      daily: async () => { if (failure === 'dump') throw new Error('PRIVATE_SENTINEL'); return '' },
      recheck: async () => { if (failure === 'local-release') rmSync(join(directory, '.backup-run.lock')); if (failure === 'readback') throw new Error('PRIVATE_SENTINEL'); return {} as Awaited<ReturnType<typeof recheckNewest>> },
    }), { message: `stage=publish category=${failure === 'local' ? 'busy' : failure === 'local-release' ? 'missing' : 'operation'}` })
    assert.deepEqual(events, ['backup-failed'])
    assert.equal(existsSync(join(directory, '.backup-run.lock')), failure === 'local')
  }
})
test('systemd daily calendar and persistence match the schedule contract', () => {
  const timer = readFileSync(new URL('../deploy/systemd/fukulow-backup.timer', import.meta.url), 'utf8')
  assert.equal(/^OnCalendar=(.*)$/m.exec(timer)?.[1], backupSchedule.dailyUTC)
  assert.equal(/^Persistent=(.*)$/m.exec(timer)?.[1], String(backupSchedule.persistent))
  const service = readFileSync(new URL('../deploy/systemd/fukulow-backup.service', import.meta.url), 'utf8')
  assert.match(service, /^User=fukulow-backup$/m)
  assert.match(service, /^ExecStart=.*scripts\/backup-r2-daily.ts \$\{FUKULOW_BACKUP_CONFIG\}$/m)
})

test('daily default dump borrows the existing local lock through publication and readback', t => {
  const { directory } = fixture(t), docker = join(directory, 'docker')
  writeFileSync(docker, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('pg_dump (PostgreSQL) 18.6');
else if (args.includes('pg_dump')) process.stdout.write('dump');
else if (args.includes('pg_restore')) require('node:fs').readFileSync(0);
else process.exit(1);
`, { mode: 0o700 })
  const script = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { dailyBackup, recheckNewest } from ${JSON.stringify(new URL('./backup-r2.ts', import.meta.url).href)};
    import { FakeBucket } from ${JSON.stringify(new URL('./backup-r2-fake.ts', import.meta.url).href)};
    import { acquireLocalLock } from ${JSON.stringify(new URL('./backup-safety.ts', import.meta.url).href)};
    const directory = process.argv[1], bucket = new FakeBucket(Date.now), release = acquireLocalLock(directory);
    try {
      const prefix = await dailyBackup({ directory, recipient: 'test', bucket, now: Date.now, localLock: release,
        notify: async () => {}, encrypt: (_source, target) => writeFileSync(target, 'cipher') });
      if (!existsSync(join(directory, '.backup-run.lock')) || (await recheckNewest(bucket, Date.now())).prefix !== prefix) process.exitCode = 2;
    } finally { release() }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script, directory], {
    encoding: 'utf8', env: { ...process.env, PATH: directory + ':' + process.env.PATH },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!existsSync(join(directory, '.backup-run.lock')))
})
