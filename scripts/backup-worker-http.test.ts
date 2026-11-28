import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyticsUsage, discordNotifier, type Fetch } from '../workers/backup-checker/http.ts'
import { epoch, cachedUsage, fixture, noGuard } from './backup-worker-test-helpers.ts'

test('fetch Discord notifier shares fixed text bounds retries and caps Retry-After', async () => {
  for (const statuses of [[429, 503, 204], [503, 503, 503], [400], [0, 0, 0]]) {
    let calls = 0
    const delays: number[] = []
    const notify = discordNotifier('https://notify.invalid/', noGuard, async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).content, 'Fukulow backup: checker-failed.')
      assert.deepEqual(JSON.parse(String(init?.body)).allowed_mentions, { parse: [] })
      assert.ok(init?.signal instanceof AbortSignal)
      const status = statuses[calls++]
      if (!status) throw new Error('PRIVATE_SENTINEL')
      return new Response(null, { status, headers: { 'retry-after': '9999' } })
    }, async ms => { delays.push(ms) })
    if (statuses.at(-1) === 204) await notify('checker-failed')
    else await assert.rejects(notify('checker-failed'), /Notification failed category=(unavailable|rejected)/)
    assert.equal(calls, statuses.length)
    assert.deepEqual(delays, statuses.slice(1).map((_, i) => statuses[i] ? 30_000 : 1000))
    await assert.rejects(notify('PRIVATE_SENTINEL'))
    assert.equal(calls, statuses.length)
  }
})

test('fetch analytics uses the shared account-wide parser and unknown usage freezes DO pruning', async () => {
  const f = fixture()
  const usage = analyticsUsage({ url: f.env.ANALYTICS_URL, account: f.env.ANALYTICS_ACCOUNT, token: f.env.ANALYTICS_TOKEN }, noGuard, async (url, init) => {
    assert.equal(String(url), f.env.ANALYTICS_URL)
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-only')
    const body = JSON.parse(String(init?.body))
    assert.ok(!body.query.includes('bucket'))
    assert.ok(!body.query.includes('groupBy'))
    assert.match(body.query, /dimensions \{ actionType \}/)
    return Response.json({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'PutObject' }, sum: { requests: 2 } },
      { dimensions: { actionType: 'GetObject' }, sum: { requests: 3 } },
    ] }] } } })
  })
  assert.deepEqual(await usage.read(epoch, { usageCache: cachedUsage() }), { classA: 2, classB: 19 })
  f.env.ANALYTICS_TOKEN = ''
  assert.equal((await f.create().fetch()).status, 204)
  assert.ok(f.events.some(e => e.includes('operations-unknown')))
  assert.ok(!f.binding.bucket.calls.some(c => c.startsWith('DELETE')))
})

test('shared external adapter budget rejects work before fetch and retains three failure attempts', async () => {
  const { RunBudget } = await import('../workers/backup-checker/budget.ts')
  const budget = new RunBudget(), calls: string[] = []
  const request: Fetch = async url => {
    calls.push(String(url))
    return String(url).includes('analytics') ? Response.json({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [
      { dimensions: { actionType: 'GetObject' }, sum: { requests: 1 } },
    ] }] } } }) : new Response(null, { status: 503 })
  }
  const usage = analyticsUsage({ url: 'https://analytics.invalid/', token: 'test-only', account: 'test-only' }, noGuard, request, budget)
  const notify = discordNotifier('https://notify.invalid/', noGuard, request, async () => {}, Date.now, budget)
  // Nine normal attempts: four + four analytics, then one notification attempt.
  for (let i = 0; i < 2; i++) await assert.rejects(usage.read(Date.UTC(2026, 9, 31, 12)), /unavailable/)
  await assert.rejects(notify('stale-backup'), /budget/)
  assert.equal(calls.length, 9)
  await assert.rejects(usage.read(Date.UTC(2026, 9, 1, 12)), /unavailable/)
  assert.equal(calls.length, 9)
  await assert.rejects(notify('checker-failed'), /unavailable/)
  assert.equal(calls.length, 12)
  assert.equal(calls.filter(url => url.includes('notify')).length, 4)
  await assert.rejects(notify('checker-failed'), /budget/)
  assert.equal(calls.length, 12)
})
