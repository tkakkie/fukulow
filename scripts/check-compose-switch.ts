// #469 switch/rollback gate: Caddy -> nginx -> Caddy -> (failed nginx, restored) -> nginx
// through deploy/switch-proxy.sh, against a disposable Pebble CA. Never reads deployment .env.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acmeFixture, caActivity, certificate, checkStartupReuse, checkVerifiedTls, pebbleIssuingRoot, poll, testDomain } from './compose-acme.ts'

type Proxy = 'caddy' | 'nginx'
const proxies: Proxy[] = ['caddy', 'nginx']
const cwd = fileURLToPath(new URL('..', import.meta.url))
const project = `fukulow-switch-${randomUUID().slice(0, 8)}`
const directory = mkdtempSync(join(process.env.CHECK_COMPOSE_WORK_DIR || tmpdir(), project))
const override = join(directory, 'compose.yml')
const image = process.env.CHECK_COMPOSE_IMAGE || 'fukulow-app'
const env = { PATH: process.env.PATH, POSTGRES_PASSWORD: 'compose-switch-db-test-only',
  POSTGRES_APP_PASSWORD: 'compose-switch-app-test-only', FUKULOW_SETUP_TOKEN: 'compose-switch-setup-test-only',
  // Separate second-octet range from the security (128-191) and restart (192-255) checks.
  FUKULOW_EDGE_PREFIX: process.env.CHECK_EDGE_PREFIX || `10.${randomInt(64, 128)}.${randomInt(256)}`,
  FUKULOW_COOKIE_SECURE: 'true', FUKULOW_DOMAIN: testDomain }
const composeOptions = ['--env-file', '/dev/null', '-p', project, '-f', 'compose.yml', '-f', override]
const attempt = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 300_000, stdio: 'pipe' })
const run = (args: string[]) => {
  const result = attempt('docker', args)
  // Never forward raw container/CA logs into CI diagnostics.
  assert.equal(result.status, 0, `docker ${args[0]} failed (output suppressed)`)
  return result.stdout.trim()
}
// The fixture's ACME directory names a proxy service, so Compose needs both profiles
// enabled to parse it. Only commands naming their services (or read-only) use this.
const dc = (...args: string[]) => run(['compose', ...composeOptions, '--profile', 'caddy', '--profile', 'nginx', ...args])
// Both profiles only so Compose can parse the fixture; the script names every service it touches.
const switchProxy = (target: Proxy, ...extra: string[]) =>
  attempt('bash', ['deploy/switch-proxy.sh', target, ...composeOptions, '--profile', 'caddy', '--profile', 'nginx', ...extra])
// Compose status lines only (no container logs); match the script's own outcome line.
function switched(target: Proxy) {
  const result = switchProxy(target)
  assert.equal(result.status, 0, `switch to ${target} failed (output suppressed)`)
  assert.match(result.stdout, new RegExp(`^switch-proxy: ${target} is serving`, 'm'))
}
// Longer than the whole run: any new CA order below is a reissue, never a renewal.
const fixture = (active: Proxy) => writeFileSync(override, `services:
  migrate:
    image: ${image}
  app:
    image: ${image}
${acmeFixture(directory, active, run, { proxies, validity: 3600 })}`)

function running(): string[] {
  return run(['ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'status=running',
    '--format', '{{.Label "com.docker.compose.service"}}']).split('\n').filter(name => proxies.includes(name as Proxy)).sort()
}
const port = (proxy: Proxy) => Number(dc('port', proxy, '443').split(':').at(-1))
const activity = () => caActivity(run(['logs', dc('ps', '-q', 'pebble')]))
function health(proxy: Proxy) {
  const url = `https://${testDomain}:${port(proxy)}/api/v1/health`
  return execFileSync('curl', ['--noproxy', '*', '--connect-to', `${testDomain}::127.0.0.1:`, '--insecure', '-sS',
    '--max-time', '10', url], { encoding: 'utf8', timeout: 15_000 }).trim()
}

// The ACME directory is loopback-only in the active proxy's network namespace.
function followDirectory(proxy: Proxy) {
  fixture(proxy)
  dc('up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '30', 'acme-directory')
}

async function serving(proxy: Proxy, root: string, untrustedCa: string) {
  assert.deepEqual(running(), [proxy], 'exactly one proxy runs after a switch')
  followDirectory(proxy)
  await poll(`${proxy} certificate`, () => certificate(port(proxy)), value => !!value)
  const serial = await checkVerifiedTls(port(proxy), root, untrustedCa)
  await poll(`${proxy} HTTPS health`, () => { try { return health(proxy) } catch { return '' } }, body => body === 'ok', 30_000)
  return serial
}

// Returning to a profile must reuse its persisted certificate and account: no order.
async function reused(proxy: Proxy, before: { serial: string, orders: number, accounts: number }, root: string, untrustedCa: string) {
  const serial = await serving(proxy, root, untrustedCa)
  const readyAt = Date.now()
  await poll(`${proxy} reuse observation`, async () => {
    const served = await certificate(port(proxy))
    assert.ok(served, 'persisted certificate stays available')
    return checkStartupReuse(before, { serial: served.serial, ...activity() }, readyAt, Date.now())
  }, Boolean, 30_000)
  assert.equal(serial, before.serial)
}

async function main() {
  fixture('caddy')
  run(['compose', ...composeOptions, '--profile', 'caddy', 'up', '-d', '--no-build', '--wait'])
  const root = pebbleIssuingRoot(dc)
  const untrustedCa = readFileSync(join(directory, 'pebble-ca.pem'), 'utf8')
  const caddy = { serial: await serving('caddy', root, untrustedCa), ...activity() }
  console.log(`PASS caddy: issued and serving, serial ${caddy.serial}`)

  // Both proxies own the edge IP (and 80/443 in production): Docker refuses overlap.
  const overlap = attempt('docker', ['compose', ...composeOptions, '--profile', 'caddy', '--profile', 'nginx', 'up', '-d', '--no-deps', 'nginx'])
  assert.notEqual(overlap.status, 0, 'a second proxy must not start while one runs')
  assert.match(overlap.stderr, /address already in use/i, 'overlap is refused by the shared proxy address')
  dc('rm', '-fs', 'nginx')
  assert.deepEqual(running(), ['caddy'])
  assert.equal(await checkVerifiedTls(port('caddy'), root, untrustedCa), caddy.serial)
  console.log('PASS overlap: starting nginx while caddy runs is refused; caddy keeps serving')

  fixture('nginx')
  switched('nginx')
  const nginxSerial = await serving('nginx', root, untrustedCa)
  const nginx = { serial: nginxSerial, ...activity() }
  assert.ok(nginx.orders > caddy.orders, 'nginx issues its own certificate in its own volume')
  console.log(`PASS caddy -> nginx: caddy stopped, nginx serving, serial ${nginx.serial}`)

  fixture('caddy')
  switched('caddy')
  await reused('caddy', { ...nginx, serial: caddy.serial }, root, untrustedCa)
  console.log('PASS nginx -> caddy: rollback reuses the caddy certificate and account without a new order')

  // A target that cannot start is stopped and the previous proxy restored.
  const broken = join(directory, 'broken-nginx.yml')
  writeFileSync(broken, 'services:\n  nginx:\n    environment:\n      NGINX_ACME_PACKAGE_VERSION: switch-check-mismatch\n')
  fixture('nginx')
  const failed = switchProxy('nginx', '-f', broken)
  assert.equal(failed.status, 1, 'failed switch reports failure')
  // Restored by the script itself, not by a failure elsewhere in it.
  assert.match(failed.stderr, /^switch-proxy: nginx did not start; restoring caddy$/m)
  assert.deepEqual(running(), ['caddy'])
  fixture('caddy')
  await reused('caddy', { ...nginx, serial: caddy.serial }, root, untrustedCa)
  console.log('PASS failed switch: nginx did not start, caddy restored without a new order')

  // Recreated with the original configuration, nginx reuses its own volume.
  fixture('nginx')
  switched('nginx')
  await reused('nginx', nginx, root, untrustedCa)
  console.log('PASS caddy -> nginx again: nginx reuses its certificate and account without a new order')
}

try {
  await main()
} finally {
  attempt('docker', ['compose', ...composeOptions, '--profile', 'caddy', '--profile', 'nginx', 'down', '-v', '--remove-orphans'])
  rmSync(directory, { recursive: true, force: true })
}
