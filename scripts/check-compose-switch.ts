// #469/#810 switch/rollback gate through deploy/switch-proxy.sh: Caddy -> nginx -> Caddy, refusals
// (overlap, ports, issuance, trust, start) with restore, previous-state handling and reuse, and
// none (a test-only external TLS proxy) in each direction, against a disposable Pebble CA. Never reads deployment .env.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { acmeFixture, caActivity, certificate, checkStartupReuse, checkVerifiedTls, nodeImage, pebbleIssuingRoot, poll, testDomain } from './compose-acme.ts'
import type { ReuseObservation } from './compose-acme.ts'

type Proxy = 'caddy' | 'nginx'
type Mode = Proxy | 'none'
const proxies: Proxy[] = ['caddy', 'nginx']
const cwd = fileURLToPath(new URL('..', import.meta.url))
const project = `fukulow-switch-${randomUUID().slice(0, 8)}`
const directory = mkdtempSync(join(process.env.CHECK_COMPOSE_WORK_DIR || tmpdir(), project))
const override = join(directory, 'compose.yml')
const rootFile = join(directory, 'pebble-issuing-root.pem')
const image = process.env.CHECK_COMPOSE_IMAGE || 'fukulow-app'
const env = { PATH: process.env.PATH, POSTGRES_PASSWORD: 'compose-switch-db-test-only',
  POSTGRES_APP_PASSWORD: 'compose-switch-app-test-only', FUKULOW_SETUP_TOKEN: 'compose-switch-setup-test-only',
  // Separate second-octet range from the security (128-191) and restart (192-255) checks.
  FUKULOW_EDGE_PREFIX: process.env.CHECK_EDGE_PREFIX || `10.${randomInt(64, 128)}.${randomInt(256)}`,
  FUKULOW_COOKIE_SECURE: 'true', FUKULOW_DOMAIN: testDomain, FUKULOW_VERSION: '0.0.0-dev', FUKULOW_PUBLISH_PORT: '0' }
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
// As on a host, COMPOSE_PROFILES selects the target (the fixture's ACME directory shares the
// profile of the proxy it follows). While the script waits for verified HTTPS, the ACME directory
// follows the target into its namespace.
async function switchProxy(target: Mode, { extra = [] as string[], follow = target !== 'none', scriptEnv = {} as Record<string, string> } = {}) {
  const targetFiles = target === 'none' ? ['-f', 'compose.external-proxy.yml'] : []
  const child = spawn('bash', ['deploy/switch-proxy.sh', target, ...composeOptions, ...targetFiles, ...extra],
    { cwd, env: { ...env, COMPOSE_PROFILES: target, SWITCH_PROXY_CACERT: rootFile, ...scriptEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', exited = false
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const status = new Promise<number | null>(resolve => child.on('close', code => { exited = true; resolve(code) }))
  while (follow && !exited) {
    if (target !== 'none' && running().includes(target)) { followDirectory(target); break }
    await delay(250)
  }
  return { status: await status, stdout, stderr }
}
// Compose status lines only (no container logs); match the script's own outcome line.
async function switched(target: Mode, options?: Parameters<typeof switchProxy>[1]) {
  const result = await switchProxy(target, options)
  assert.equal(result.status, 0, `switch to ${target} failed (output suppressed)`)
  assert.match(result.stdout, target === 'none' ? /^switch-proxy: none: https:\/\/\S+ serves verified HTTPS; no bundled proxy runs$/m
    : new RegExp(`^switch-proxy: ${target} is serving verified HTTPS`, 'm'))
}
async function refused(target: Mode, reason: RegExp, outcome: RegExp, options?: Parameters<typeof switchProxy>[1]) {
  const result = await switchProxy(target, options)
  assert.notEqual(result.status, 0, `switch to ${target} must fail`)
  // The script's own reason and outcome lines, not a failure elsewhere in it.
  assert.match(result.stderr, reason)
  assert.match(result.stderr, outcome)
  return result.status
}
// Longer than the whole run: any new CA order below is a reissue, never a renewal.
// `external` stands in for the operator's own TLS proxy in none mode (self-signed, test-only key).
const fixture = (active: Proxy) => writeFileSync(override, `services:
  migrate:
    image: ${image}
  app:
    image: ${image}
  external:
    image: ${nodeImage}
    command: ["node", "-e", ${JSON.stringify(externalProxy)}]
    ports: ["127.0.0.1::8443"]
    networks: [edge]
    volumes: ["${directory}/external:/tls:ro"]
${acmeFixture(directory, active, run, { proxies, validity: 3600 })
    .replace(`network_mode: service:${active}`, `network_mode: service:${active}\n    profiles: [${active}]`)}`)
const externalProxy = `const fs = require('fs'), http = require('http')
require('https').createServer({ key: fs.readFileSync('/tls/key.pem'), cert: fs.readFileSync('/tls/cert.pem') }, (req, res) => {
  const upstream = http.request({ host: 'app', port: 8080, path: req.url, method: req.method, headers: req.headers }, reply => {
    res.writeHead(reply.statusCode, reply.headers); reply.pipe(res) })
  upstream.on('error', () => { res.writeHead(502); res.end() }); req.pipe(upstream)
}).listen(8443)`

function running(): string[] {
  return run(['ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'status=running',
    '--format', '{{.Label "com.docker.compose.service"}}']).split('\n').filter(name => proxies.includes(name as Proxy)).sort()
}
// Services publishing host ports, excluding the stand-in external proxy.
function published(): string[] {
  return run(['ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Label "com.docker.compose.service"}} {{.Ports}}'])
    .split('\n').filter(line => line.includes('->')).map(line => line.split(' ')[0]).filter(name => name !== 'external').sort()
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
  assert.deepEqual(published(), [proxy], 'only the running proxy publishes ports')
  followDirectory(proxy)
  await poll(`${proxy} certificate`, () => certificate(port(proxy)), value => !!value)
  const serial = await checkVerifiedTls(port(proxy), root, untrustedCa)
  await poll(`${proxy} HTTPS health`, () => { try { return health(proxy) } catch { return '' } }, body => body === 'ok', 30_000)
  return serial
}

// Returning to a profile must reuse its persisted certificate and account: no order.
async function reused(proxy: Proxy, before: ReuseObservation, root: string, untrustedCa: string) {
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
  mkdirSync(join(directory, 'external'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-keyout', join(directory, 'external', 'key.pem'), '-out', join(directory, 'external', 'cert.pem'),
    '-subj', `/CN=${testDomain}`, '-addext', `subjectAltName=DNS:${testDomain}`], { stdio: 'ignore' })
  fixture('caddy')
  run(['compose', ...composeOptions, '--profile', 'caddy', 'up', '-d', '--no-build', '--wait'])
  const root = pebbleIssuingRoot(dc)
  writeFileSync(rootFile, root)
  const untrustedFile = join(directory, 'pebble-ca.pem')
  const untrustedCa = readFileSync(untrustedFile, 'utf8')
  const caddy = { serial: await serving('caddy', root, untrustedCa), ...activity() }
  console.log(`PASS caddy: issued and serving, serial ${caddy.serial}`)
  const caddyBack = { ...caddy }

  // Both proxies own the edge IP (and 80/443 in production): Docker refuses overlap.
  const overlap = attempt('docker', ['compose', ...composeOptions, '--profile', 'caddy', '--profile', 'nginx', 'up', '-d', '--no-deps', 'nginx'])
  assert.notEqual(overlap.status, 0, 'a second proxy must not start while one runs')
  assert.match(overlap.stderr, /address already in use/i, 'overlap is refused by the shared proxy address')
  dc('rm', '-fs', 'nginx')
  assert.deepEqual(running(), ['caddy'])
  assert.equal(await checkVerifiedTls(port('caddy'), root, untrustedCa), caddy.serial)
  console.log('PASS overlap: starting nginx while caddy runs is refused; caddy keeps serving')

  // A target publishing other ports than the running proxy (a dropped loopback override)
  // is refused before anything stops.
  const publicPorts = join(directory, 'public-nginx.yml')
  writeFileSync(publicPorts, 'services:\n  nginx:\n    ports: !override ["::443", "::80"]\n')
  fixture('nginx')
  assert.equal(await refused('nginx', /^switch-proxy: nginx would publish \[.*\] but caddy publishes \[.*127\.0\.0\.1.*\]/m,
    /nothing changed\)$/m, { extra: ['-f', publicPorts], follow: false }), 2)
  assert.deepEqual(running(), ['caddy'])
  assert.equal(await checkVerifiedTls(port('caddy'), root, untrustedCa), caddy.serial)
  console.log('PASS port check: a switch that would publish other ports is refused; caddy untouched')

  // Issuance failure: the CA is unreachable from nginx, so HTTPS never verifies.
  fixture('caddy')
  await refused('nginx', /^switch-proxy: nginx did not serve verified HTTPS within 20s$/m, /^switch-proxy: restoring caddy; set COMPOSE_PROFILES=caddy in \.env again$/m,
    { follow: false, scriptEnv: { SWITCH_PROXY_HTTPS_TIMEOUT: '20' } })
  await reused('caddy', caddyBack, root, untrustedCa)
  console.log('PASS issuance failure: nginx never served verified HTTPS, caddy restored without a new order')

  fixture('nginx')
  await switched('nginx')
  const nginx = { serial: await serving('nginx', root, untrustedCa), ...activity() }
  assert.ok(nginx.orders > caddy.orders, 'nginx issues its own certificate in its own volume')
  console.log(`PASS caddy -> nginx: caddy stopped, nginx serving verified HTTPS, serial ${nginx.serial}`)

  fixture('caddy')
  await switched('caddy')
  await reused('caddy', { ...nginx, serial: caddy.serial }, root, untrustedCa)
  console.log('PASS nginx -> caddy: rollback reuses the caddy certificate and account without a new order')

  // Trust failure: nginx serves its certificate, but not one the operator's CA trusts.
  fixture('nginx')
  await refused('nginx', /^switch-proxy: nginx did not serve verified HTTPS within 20s$/m, /^switch-proxy: restoring caddy; set COMPOSE_PROFILES=caddy in \.env again$/m,
    { scriptEnv: { SWITCH_PROXY_CACERT: untrustedFile, SWITCH_PROXY_HTTPS_TIMEOUT: '20' } })
  fixture('caddy')
  await reused('caddy', { ...nginx, serial: caddy.serial }, root, untrustedCa)
  console.log('PASS trust failure: an untrusted certificate is rejected and caddy restored without a new order')

  // A target that cannot start is stopped and the previous proxy restored.
  const broken = join(directory, 'broken-nginx.yml')
  writeFileSync(broken, 'services:\n  nginx:\n    environment:\n      NGINX_ACME_PACKAGE_VERSION: switch-check-mismatch\n')
  fixture('nginx')
  await refused('nginx', /^switch-proxy: nginx did not turn healthy$/m, /^switch-proxy: restoring caddy; set COMPOSE_PROFILES=caddy in \.env again$/m, { extra: ['-f', broken], follow: false })
  fixture('caddy')
  await reused('caddy', { ...nginx, serial: caddy.serial }, root, untrustedCa)
  console.log('PASS failed start: nginx did not turn healthy, caddy restored without a new order')

  // A previous proxy that was not running is never started by a failed switch.
  dc('stop', 'caddy')
  assert.deepEqual(running(), [])
  fixture('nginx')
  await refused('nginx', /^switch-proxy: nginx did not turn healthy$/m, /^switch-proxy: no other proxy was running, so none is started$/m,
    { extra: ['-f', broken], follow: false })
  assert.deepEqual(running(), [], 'no proxy is started that was not running')
  console.log('PASS previous state: a failed switch leaves a stopped caddy stopped')

  // Recreated with the original configuration, nginx reuses its own volume.
  await switched('nginx')
  await reused('nginx', nginx, root, untrustedCa)
  console.log('PASS -> nginx again: nginx reuses its certificate and account without a new order')

  // none: the operator's own proxy (here `external`) must serve verified HTTPS once nginx is gone.
  const externalCa = join(directory, 'external', 'cert.pem')
  const none = { SWITCH_PROXY_URL: `https://${testDomain}`, SWITCH_PROXY_CONNECT_TO: `127.0.0.1:${dc('port', 'external', '8443').split(':').at(-1)}` }
  await refused('none', /^switch-proxy: none did not serve verified HTTPS within 20s$/m, /^switch-proxy: restoring nginx; set COMPOSE_PROFILES=nginx in \.env again$/m,
    { scriptEnv: { ...none, SWITCH_PROXY_HTTPS_TIMEOUT: '20' } })
  await reused('nginx', nginx, root, untrustedCa)
  console.log('PASS none trust failure: an untrusted external certificate is rejected and nginx restored')
  const unproxied = () => {
    assert.deepEqual(running(), [], 'no bundled proxy runs in none mode')
    assert.deepEqual(published(), ['app'], 'only the app publishes a port in none mode')
    assert.match(run(['port', dc('ps', '-q', 'app'), '8080/tcp']), /^127\.0\.0\.1:[1-9]\d*$/)
  }
  await switched('none', { scriptEnv: { ...none, SWITCH_PROXY_CACERT: externalCa } })
  unproxied()
  console.log('PASS nginx -> none: nginx stopped and unpublished; the external proxy serves verified HTTPS')
  fixture('caddy')
  await switched('caddy')
  await reused('caddy', { ...nginx, serial: caddy.serial }, root, untrustedCa)
  console.log('PASS none -> caddy: caddy serves again without a new order')
  await switched('none', { scriptEnv: { ...none, SWITCH_PROXY_CACERT: externalCa } })
  unproxied()
  console.log('PASS caddy -> none: caddy stopped and unpublished')
  fixture('nginx')
  await switched('nginx')
  await reused('nginx', nginx, root, untrustedCa)
  console.log('PASS none -> nginx: nginx serves again without a new order')
}

try {
  await main()
} finally {
  attempt('docker', ['compose', ...composeOptions, '--profile', 'caddy', '--profile', 'nginx', 'down', '-v', '--remove-orphans'])
  rmSync(directory, { recursive: true, force: true })
}
