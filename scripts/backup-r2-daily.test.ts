import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { backupSchedule, bucketRunLock, dailyBackup, recheckNewest } from './backup-r2.ts'
import { runDaily } from './backup-r2-daily.ts'
import { fakeS3 } from './backup-r2-fake.ts'
import { memoryRunLock } from './backup-safety.ts'

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'daily-wiring-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const configFile = join(directory, 'config'), recipientFile = join(directory, 'recipient')
  writeFileSync(recipientFile, 'test-public-recipient', { mode: 0o600 })
  writeFileSync(configFile, JSON.stringify({ directory, recipientFile, curlConfigFile: join(directory, 'curl'),
    baseUrl: 'https://backup.invalid/', notifierConfigFile: join(directory, 'notify') }), { mode: 0o600 })
  return { directory, configFile }
}
test('daily VPS wiring holds both locks through backup and final readback', async t => {
  const { directory, configFile } = fixture(t), now = Date.now()
  const fake = await fakeS3(() => now); t.after(fake.close)
  const source = join(directory, 'source'); writeFileSync(source, 'dump')
  let held = false, checked = false
  const events: string[] = []
  await runDaily(configFile, {
    runner: async () => fake.runner('backups'), notifier: async () => async event => { events.push(event) },
    lockFactory: run => async work => { held = true; try { return await bucketRunLock(run)(work) } finally { held = false } }, now: () => now,
    daily: options => dailyBackup({ ...options, dump: (_d, capture) => { capture(); return source },
      encrypt: (_s, target) => writeFileSync(target, 'cipher') }),
    recheck: async (bucket, at) => {
      assert.ok(held); assert.ok(existsSync(join(directory, '.backup-run.lock')))
      checked = true; return recheckNewest(bucket, at)
    },
  })
  assert.ok(checked); assert.ok(!held); assert.ok(!existsSync(join(directory, '.backup-run.lock')))
  assert.deepEqual(events, ['daily-readback-failed']) // first backup has no predecessor
})
test('daily VPS failures notify once and release locks with safe diagnostics', async t => {
  for (const failure of ['acquire', 'dump', 'readback', 'release', 'local']) {
    const { directory, configFile } = fixture(t), fake = await fakeS3(Date.now); t.after(fake.close)
    const events: string[] = []
    if (failure === 'local') writeFileSync(join(directory, '.backup-run.lock'), '')
    await assert.rejects(runDaily(configFile, {
      runner: async () => fake.runner('backups'), notifier: async () => async event => { events.push(event) },
      lockFactory: () => async work => {
        if (failure === 'acquire') throw new Error('PRIVATE_SENTINEL')
        const result = await memoryRunLock()(work)
        if (failure === 'release') throw new Error('PRIVATE_SENTINEL')
        return result
      },
      daily: async () => { if (failure === 'dump') throw new Error('PRIVATE_SENTINEL'); return '' },
      recheck: async () => { if (failure === 'readback') throw new Error('PRIVATE_SENTINEL'); return {} as Awaited<ReturnType<typeof recheckNewest>> },
    }), { message: `stage=publish category=${failure === 'local' ? 'busy' : 'operation'}` })
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
