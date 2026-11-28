import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acmeFixture, buildRenewalPebble, caActivity, challengeResponses, checkReuse, checkStartupReuse, checkLifetimeRenewal, lifetimeRenewalNotBefore, pebbleImage, poll, renewalPebbleImage } from './compose-acme.ts'
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
  const before = { serial: '0123', orders: 1, accounts: 1, validations: 1 }
  checkReuse(before, { ...before })
  for (const after of [{ ...before, serial: '4567' }, { ...before, orders: 2 }, { ...before, accounts: 2 }, { ...before, validations: 2 }]) {
    assert.throws(() => checkReuse(before, after), /restart\/recreation/)
  }
  assert.throws(() => checkReuse({ ...before, orders: 0 }, { ...before, orders: 0 }), /observation must be active/)
  assert.throws(() => checkReuse({ ...before, accounts: 0 }, { ...before, accounts: 0 }), /observation must be active/)
  assert.throws(() => checkReuse({ ...before, validations: 0 }, { ...before, validations: 0 }), /observation must be active/)
})

test('CA activity distinguishes existing account lookup from account creation', () => {
  const log = 'POST /sign-me-up\nThere are now 1 accounts in memory\nPOST /order-plz\n'
  assert.deepEqual(caActivity(log), { orders: 1, accounts: 1, validations: 0 })
  assert.deepEqual(caActivity(log + 'POST /sign-me-up\n'), { orders: 1, accounts: 1, validations: 0 })
  assert.deepEqual(caActivity(log + 'There are now 2 accounts in memory\nPOST /order-plz\n'), { orders: 2, accounts: 2, validations: 0 })
  assert.deepEqual(caActivity(''), { orders: 0, accounts: 0, validations: 0 })
  // Pebble va.go lines; an INVALID result or a reused authorization adds none.
  const validated = log + 'authz Xy1 set VALID by completed challenge Ch1\nauthz Xy2 set INVALID by completed challenge Ch2\n'
  assert.equal(caActivity(validated).validations, 1)
})

test('startup observation rejects delayed reissuance after initially serving the persisted certificate', () => {
  const before = { serial: '0123', orders: 1, accounts: 1, validations: 1 }
  assert.equal(checkStartupReuse(before, before, 1000, 1000), false)
  assert.equal(checkStartupReuse(before, before, 1000, 15_999), false)
  assert.equal(checkStartupReuse(before, before, 1000, 16_000), true)
  // The old first-certificate check passed this first sample. A background order
  // twelve seconds later must fail even while the old serial is still served.
  assert.throws(() => checkStartupReuse(before, { ...before, orders: 2 }, 1000, 13_000), /restart\/recreation/)
  assert.throws(() => checkStartupReuse(before, { ...before, orders: 2, serial: '4567' }, 1000, 16_000), /restart\/recreation/)
})

test('lifetime renewal rejects early startup orders independently of the startup observation window', () => {
  const before = { serial: '0123', orders: 1, accounts: 1, validations: 1 }
  const late = { starts: 288_000 }
  const window = lifetimeRenewalNotBefore({ starts: 1000, expires: 600_000 })
  assert.equal(window, 288_000, 'nginx truncates the 287.52s offset to whole seconds')
  assert.equal(checkLifetimeRenewal(before, { ...before, ...late, ...late }, 60_000, window), false)
  for (const after of [{ ...before, orders: 2 }, { ...before, serial: '4567', orders: 2 }]) {
    assert.throws(() => checkLifetimeRenewal(before, { ...after, ...late }, 60_000, window), /restart\/recreation/)
  }
  assert.equal(checkLifetimeRenewal(before, { ...before, ...late, orders: 2 }, window, window), false)
  const renewed = { ...before, ...late, orders: 2, serial: '4567', validations: 2 }
  assert.equal(checkLifetimeRenewal(before, renewed, window, window), true)
  assert.throws(() => checkLifetimeRenewal(before, { ...renewed, orders: 1 }, window, window), /fresh CA order/)
  assert.throws(() => checkLifetimeRenewal(before, { ...renewed, accounts: 2 }, window, window), /persisted account/)
  // #939: an order that reused a valid authorization issues without any challenge.
  assert.throws(() => checkLifetimeRenewal(before, { ...renewed, validations: 1 }, window, window), /fresh authorization/)
  // An order placed before the window whose certificate is first served after it.
  assert.throws(() => checkLifetimeRenewal(before, { ...renewed, starts: 287_000 }, window + 5_000, window),
    /lifetime renewal window/)
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

function checkRenewalPebble(dockerfile: string, fixture: string, security: string) {
  // No `# syntax=` line: it would pull an unpinned BuildKit frontend image.
  assert.doesNotMatch(dockerfile, /^#\s*syntax=/im)
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map(match => match[1])
  assert.deepEqual(froms.length, 2)
  assert.match(froms[0], /^golang:\d+\.\d+\.\d+-bookworm@sha256:[a-f0-9]{64}$/, 'Go builder must pin exact tag and digest')
  // The runtime stage is the pinned release image itself, passed in from pebbleImage.
  assert.equal(froms[1], '${PEBBLE_IMAGE}')
  assert.match(dockerfile, /^ARG PEBBLE_COMMIT=[a-f0-9]{40}$/m)
  assert.match(dockerfile, /git fetch --quiet --depth 1 https:\/\/github\.com\/letsencrypt\/pebble "\$PEBBLE_COMMIT"/)
  assert.match(dockerfile, /test "\$\(git rev-parse HEAD\)" = "\$PEBBLE_COMMIT"/)
  // Exactly the reuse comparison changes, nothing else.
  assert.match(dockerfile, /s\/rand\.Intn\(100\) > wfe\.authzReusePercent\/rand\.Intn\(100\) >= wfe\.authzReusePercent\//)
  assert.match(dockerfile, /git diff --numstat \| awk '\{ print \$1 \+ \$2 \}'\)" = 2/)
  assert.match(dockerfile, /GOPROXY=off GOTOOLCHAIN=local GOFLAGS=-mod=vendor go build/)
  // The rebuilt binary replaces the release binary; without this the image runs unpatched Pebble.
  assert.match(dockerfile, /^COPY --from=build \/pebble \/app$/m)
  assert.match(fixture, /PEBBLE_AUTHZREUSE: "0"/)
  assert.match(fixture, /^\s+image: \$\{ca\}$/m)
  assert.match(security, /if \(lifecycle\) ca = buildRenewalPebble\(directory, run\)/)
  assert.match(security, /acmeFixture\(directory, profile, run, \{ ca \}\)/)
}

test('the renewal check uses Pebble rebuilt so authorization reuse 0 means never (#939)', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const dockerfile = read('./compose-acme-pebble.Dockerfile')
  const fixture = read('./compose-acme.ts')
  const security = read('./check-compose-security.ts')
  checkRenewalPebble(dockerfile, fixture, security)
  for (const [changed, mutate] of [
    ['dockerfile', (text: string) => text.replace(/@sha256:[a-f0-9]{64} AS build/, ' AS build')],
    ['dockerfile', (text: string) => text.replace('FROM ${PEBBLE_IMAGE}', 'FROM ghcr.io/letsencrypt/pebble:latest')],
    ['dockerfile', (text: string) => text.replace(' && test "$(git rev-parse HEAD)" = "$PEBBLE_COMMIT"', '')],
    ['dockerfile', (text: string) => text.replace('>= wfe.authzReusePercent/', '> wfe.authzReusePercent/')],
    ['dockerfile', (text: string) => text.replace(/ \\\n && test "\$\(git diff --numstat[^\n]*/, '')],
    ['dockerfile', (text: string) => text.replace('COPY --from=build /pebble /app', '')],
    ['dockerfile', (text: string) => text.replace('https://github.com/letsencrypt/pebble', 'https://github.com/example/pebble')],
    ['dockerfile', (text: string) => text.replace('GOPROXY=off ', '')],
    ['dockerfile', (text: string) => `# syntax=docker/dockerfile:1\n${text}`],
    ['fixture', (text: string) => text.replace('PEBBLE_AUTHZREUSE: "0"', 'PEBBLE_AUTHZREUSE: "1"')],
    ['security', (text: string) => text.replace('if (lifecycle) ca = buildRenewalPebble(directory, run)', '')],
  ] as const) {
    assert.throws(() => checkRenewalPebble(changed === 'dockerfile' ? mutate(dockerfile) : dockerfile,
      changed === 'fixture' ? mutate(fixture) : fixture, changed === 'security' ? mutate(security) : security), undefined, String(mutate))
  }
  const calls: string[][] = []
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-pebble-build-'))
  try {
    assert.equal(buildRenewalPebble(directory, args => { calls.push(args); return '' }), renewalPebbleImage)
  } finally { rmSync(directory, { recursive: true, force: true }) }
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(0, 5), ['build', '--quiet', '--load', '--build-arg', `PEBBLE_IMAGE=${pebbleImage}`])
  assert.ok(calls[0].at(-1)?.endsWith('pebble-build'), 'empty build context')
})
