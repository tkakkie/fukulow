import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { discordNotifier, notificationText } from './backup-notify.ts'
import { checkerAlerts } from './backup-r2-state.ts'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'notify-test-')), config = join(root, 'config')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Deliberately non-routable, never requested by these injected executors.
  const url = 'https://notification.invalid/'
  writeFileSync(config, JSON.stringify({ webhookUrl: url }), { mode: 0o600 })
  return { root, config, url }
}
test('notifier permits only fixed events and numeric alive fields', () => {
  for (const event of [...checkerAlerts, 'backup-failed', 'daily-readback-failed']) assert.equal(notificationText(event), `Fukulow backup: ${event}.`)
  const alive = { event: 'checker-alive', newestCapture: '2026-11-17T00:00:00.000Z', backupBytes: 1, imageBytes: 2, total: 3, percentage: 0.1, operations: { classA: 4, classB: 5 }, private: 'PRIVATE_SENTINEL' }
  assert.doesNotMatch(notificationText(JSON.stringify(alive)), /PRIVATE_SENTINEL/)
  assert.match(notificationText(JSON.stringify(alive)), /newestCapture=1794873600000/)
  for (const event of ['PRIVATE_SENTINEL', '{}', JSON.stringify({ ...alive, total: 'PRIVATE_SENTINEL' }), JSON.stringify({ ...alive, operations: { classA: -1, classB: 0 } })]) assert.throws(() => notificationText(event))
})
test('Discord retry is capped at three with Retry-After and URL only on stdin', async t => {
  const { config, url } = fixture(t), delays: number[] = [], statuses = [429, 503, 204]
  let calls = 0
  const notify = await discordNotifier(config, async (args, input) => {
    assert.ok(!args.join().includes(url)); assert.ok(input.includes(url))
    assert.equal(args[args.indexOf('--retry') + 1], '0')
    const payload = JSON.parse(args[args.indexOf('--data-binary') + 1])
    assert.equal(payload.content, 'Fukulow backup: backup-failed.')
    assert.deepEqual(payload.allowed_mentions, { parse: [] })
    writeFileSync(args[args.indexOf('--dump-header') + 1], `HTTP/1.1 ${statuses[calls++]} response\r\nRetry-After: 9999\r\n\r\n`)
  }, async delay => { delays.push(delay) })
  await notify('backup-failed')
  assert.equal(calls, 3); assert.deepEqual(delays, [30_000, 30_000])
})
test('notifier suppresses transport errors and rejects other 4xx immediately', async t => {
  const { config } = fixture(t)
  for (const status of [0, 400]) {
    let calls = 0
    const notify = await discordNotifier(config, async args => {
      calls++
      if (!status) throw new Error('PRIVATE_SENTINEL')
      writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/1.1 400 PRIVATE_SENTINEL\r\n\r\n')
    }, async () => {})
    await assert.rejects(notify('checker-failed'), { message: `Notification failed category=${status ? 'rejected' : 'unavailable'}` })
    assert.equal(calls, status ? 1 : 3)
  }
})
test('notifier refuses permissive symlink and checkout configuration', async t => {
  const { root, config } = fixture(t), link = join(root, 'link')
  symlinkSync(config, link)
  await assert.rejects(discordNotifier(link), /category=configuration/)
  chmodSync(config, 0o644)
  await assert.rejects(discordNotifier(config), /category=configuration/)
  await assert.rejects(discordNotifier(new URL('../AGENTS.md', import.meta.url).pathname), /category=configuration/)
})
