import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { analyticsClient } from './backup-r2-usage.ts'
import { fixture } from './backup-r2-test-helpers.ts'

test('analytics transport keeps private configuration and query out of argv and suppresses raw failures', async t => {
  const root = fixture(t), config = join(root, 'config'), account = randomUUID()
  writeFileSync(config, '', { mode: 0o600 })
  const requests: { args: string[]; input: string }[] = []
  const client = await analyticsClient(config, async (args, input) => {
    requests.push({ args, input })
    writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ data: 'test' }))
  })
  assert.deepEqual(await client.query({ query: 'query test', variables: { account } }), { data: 'test' })
  assert.ok(!requests[0].args.join().includes(account))
  assert.ok(!requests[0].args.includes('query test'))
  assert.equal(JSON.parse(requests[0].input).variables.account, account)
  assert.ok(requests[0].args.includes('--fail') && requests[0].args.includes('--max-time'))
  assert.deepEqual(readdirSync(root), ['config'])
  const failed = await analyticsClient(config, async () => { throw new Error('PRIVATE_SENTINEL') })
  await assert.rejects(failed.query({ query: '', variables: {} }), { message: 'Account operation usage unavailable' })
  const malformed = await analyticsClient(config, async args => writeFileSync(args[args.indexOf('--output') + 1], 'PRIVATE_SENTINEL'))
  await assert.rejects(malformed.query({ query: '', variables: {} }), { message: 'Account operation usage unavailable' })
  chmodSync(config, 0o644)
  await assert.rejects(analyticsClient(config), /Private external/)
})
