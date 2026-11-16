import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acmeFixture, caActivity, challengeResponses, checkReuse, checkStartupReuse, checkLifetimeRenewal, lifetimeRenewalNotBefore, poll } from './compose-acme.ts'
import { lifetimeDirectory } from './compose-acme-directory.ts'

test('CI directory omits only ARI so short-lived renewal uses a predictable lifetime schedule', () => {
  const directory = { newOrder: 'https://pebble:14000/order-plz', newNonce: 'https://pebble:14000/nonce-plz', renewalInfo: 'https://pebble:14000/ari', meta: { termsOfService: 'test' } }
  const { renewalInfo: _ari, ...rest } = directory
  assert.deepEqual(JSON.parse(lifetimeDirectory(JSON.stringify(directory))), rest)
  assert.deepEqual(JSON.parse(lifetimeDirectory(JSON.stringify(rest))), rest)
  assert.throws(() => lifetimeDirectory('{invalid'))
})

test('both generated proxy fixtures use the local CA and retain production Host and API policies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-acme-config-'))
  try {
    acmeFixture(directory, 'caddy', () => 'fixture-container')
    const caddy = readFileSync(join(directory, 'Caddyfile'), 'utf8')
    assert.match(caddy, /renew_interval 5s\n\s+renewal_window_ratio 0.5/)
    assert.equal((caddy.match(/dir http:\/\/127.0.0.1:14001\/dir/g) ?? []).length, 1)
    assert.match(caddy, /disable_tlsalpn_challenge/)
    assert.match(caddy, /strict_sni_host on/)
    assert.match(caddy, /header @api >Cache-Control "no-store"/)
    const nginx = readFileSync(join(directory, 'nginx.conf'), 'utf8')
    assert.match(nginx, /uri http:\/\/127.0.0.1:14001\/dir;/)
    assert.doesNotMatch(nginx, /acme-v02.api.letsencrypt.org/)
    assert.match(nginx, /ssl_reject_handshake on;/)
    assert.match(nginx, /add_header Cache-Control \$response_cache_control always;/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
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

test('startup observation rejects delayed reissuance after initially serving the persisted certificate', () => {
  const before = { serial: '0123', orders: 1, accounts: 1 }
  assert.equal(checkStartupReuse(before, before, 1000, 1000), false)
  assert.equal(checkStartupReuse(before, before, 1000, 15_999), false)
  assert.equal(checkStartupReuse(before, before, 1000, 16_000), true)
  // The old first-certificate check passed this first sample. A background order
  // twelve seconds later must fail even while the old serial is still served.
  assert.throws(() => checkStartupReuse(before, { ...before, orders: 2 }, 1000, 13_000), /restart\/recreation/)
  assert.throws(() => checkStartupReuse(before, { ...before, orders: 2, serial: '4567' }, 1000, 16_000), /restart\/recreation/)
})

test('lifetime renewal rejects early startup orders independently of the startup observation window', () => {
  const before = { serial: '0123', orders: 1, accounts: 1 }
  const window = lifetimeRenewalNotBefore({ starts: 1000, expires: 600_000 })
  assert.equal(window, 288_000, 'nginx truncates the 287.52s offset to whole seconds')
  assert.equal(checkLifetimeRenewal(before, before, 60_000, window), false)
  for (const after of [{ ...before, orders: 2 }, { ...before, serial: '4567', orders: 2 }]) {
    assert.throws(() => checkLifetimeRenewal(before, after, 60_000, window), /restart\/recreation/)
  }
  assert.equal(checkLifetimeRenewal(before, { ...before, orders: 2 }, window, window), false)
  assert.equal(checkLifetimeRenewal(before, { ...before, orders: 2, serial: '4567' }, window, window), true)
  assert.throws(() => checkLifetimeRenewal(before, { ...before, serial: '4567' }, window, window), /fresh CA order/)
  assert.throws(() => checkLifetimeRenewal(before, { ...before, orders: 2, serial: '4567', accounts: 2 }, window, window), /persisted account/)
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
