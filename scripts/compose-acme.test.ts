import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { caActivity, challengeResponses, checkReuse, poll } from './compose-acme.ts'
import { lifetimeDirectory } from './compose-acme-directory.ts'

test('CI directory omits only ARI so short-lived renewal uses a predictable lifetime schedule', () => {
  const directory = { newOrder: 'https://pebble:14000/order-plz', newNonce: 'https://pebble:14000/nonce-plz', renewalInfo: 'https://pebble:14000/ari', meta: { termsOfService: 'test' } }
  const { renewalInfo: _ari, ...rest } = directory
  assert.deepEqual(JSON.parse(lifetimeDirectory(JSON.stringify(directory))), rest)
  assert.deepEqual(JSON.parse(lifetimeDirectory(JSON.stringify(rest))), rest)
  assert.throws(() => lifetimeDirectory('{invalid'))
})

test('HTTP-01 evidence requires real validation responses and rejects redirects', () => {
  for (const profile of ['caddy', 'nginx']) {
    const log = (statuses: number[]) => () => statuses.map(status => profile === 'nginx' ? String(status) : JSON.stringify({ status })).join('\n')
    assert.equal(challengeResponses(profile, 'fixture', log([404, 200, 200])), 2)
    assert.throws(() => challengeResponses(profile, 'fixture', log([404])), /HTTP 200/)
    assert.throws(() => challengeResponses(profile, 'fixture', log([200, 308])), /never redirect/)
  }
})

test('certificate reuse requires the same serial and no new CA orders or accounts', () => {
  const before = { serial: '0123', orders: 1, accounts: 1 }
  checkReuse(before, { ...before })
  for (const after of [{ ...before, serial: '4567' }, { ...before, orders: 2 }, { ...before, accounts: 2 }]) {
    assert.throws(() => checkReuse(before, after), /restart\/recreation/)
  }
  assert.throws(() => checkReuse({ ...before, orders: 0 }, { ...before, orders: 0 }), /observation must be active/)
  assert.throws(() => checkReuse({ ...before, accounts: 0 }, { ...before, accounts: 0 }), /observation must be active/)
})

test('CA activity distinguishes existing account lookup from account creation', () => {
  const log = 'POST /sign-me-up\nThere are now 1 accounts in memory\nPOST /order-plz\n'
  assert.deepEqual(caActivity(log), { orders: 1, accounts: 1 })
  assert.deepEqual(caActivity(log + 'POST /sign-me-up\n'), { orders: 1, accounts: 1 })
  assert.deepEqual(caActivity(log + 'There are now 2 accounts in memory\nPOST /order-plz\n'), { orders: 2, accounts: 2 })
  assert.deepEqual(caActivity(''), { orders: 0, accounts: 0 })
})

test('ACME state polling has a deadline and propagates observation failures', async () => {
  let observed = 0
  assert.equal(await poll('state', () => ++observed, n => n === 3, 1000), 3)
  await assert.rejects(poll('bounded', () => false, Boolean, 1), /did not converge/)
  await assert.rejects(poll('broken', () => { throw new Error('observation failed') }, Boolean), /observation failed/)
})

function checkAcceptanceWorkflow(workflow: string) {
  assert.match(workflow, /branches: \[main\]/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.doesNotMatch(workflow, /pull_request/)
  assert.match(workflow, /profile: \[caddy, nginx\]/)
  assert.match(workflow, /CHECK_COMPOSE_ACCEPTANCE: '1'/)
  assert.match(workflow, /run: node scripts\/check-compose-security.ts/)
  const artifact = [...workflow.matchAll(/^\s+path: (.+)$/gm)].map(match => match[1])
  assert.deepEqual(artifact, ['web/test-results/ci-diagnostics/report.json'])
}

test('full Compose acceptance runs both profiles only on main or manual dispatch with restricted diagnostics', () => {
  const workflow = readFileSync(new URL('../.github/workflows/e2e-compose.yml', import.meta.url), 'utf8')
  checkAcceptanceWorkflow(workflow)
  for (const changed of [workflow.replace('branches: [main]', 'branches: [other]'),
    workflow.replace('workflow_dispatch:', 'pull_request:'), workflow.replace('[caddy, nginx]', '[caddy]'),
    workflow.replace("CHECK_COMPOSE_ACCEPTANCE: '1'", "CHECK_COMPOSE_ACCEPTANCE: '0'"),
    workflow.replace('web/test-results/ci-diagnostics/report.json', '/var/lib/nginx/acme')]) {
    assert.throws(() => checkAcceptanceWorkflow(changed))
  }
})
