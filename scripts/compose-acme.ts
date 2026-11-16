// Shared disposable CA fixture for the existing Compose security/acceptance guard.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

export const pebbleImage = 'ghcr.io/letsencrypt/pebble:2.8.0@sha256:d9080f68f6cb6af8d82134ab26de0aaaf312ac9cba42aecc6d3aede6cb63007b'
export const testDomain = 'fukulow.test'
export const nodeImage = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').match(/^FROM (node:\S+) AS web$/m)?.[1] ?? ''
assert.match(nodeImage, /^node:\d+\.\d+\.\d+-slim@sha256:[a-f0-9]{64}$/, 'reuse the pinned Node toolchain image')

// Only transient connection failures are polled. Assertions/configuration failures
// propagate immediately. The interval bounds observation load, not assertions.
export async function poll<T>(label: string, observe: () => Promise<T> | T, accept: (value: T) => boolean, milliseconds = 120_000): Promise<T> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const value = await observe()
    if (accept(value)) return value
    await setTimeout(250)
  }
  throw new Error(`${label}: observable state did not converge within ${milliseconds}ms`)
}

export function acmeFixture(directory: string, profile: string, run: (args: string[]) => string): string {
  const config = {
    pebble: { listenAddress: '0.0.0.0:14000', managementListenAddress: '0.0.0.0:15000',
      certificate: 'test/certs/localhost/cert.pem', privateKey: 'test/certs/localhost/key.pem',
      httpPort: 80, tlsPort: 443, certificateValidityPeriod: 600,
      profiles: { default: { description: 'CI ten-minute certificate', validityPeriod: 600 } },
      // Force fresh HTTP-01 validation on renewal, not cached authorizations.
      authorizationValidityPeriod: 1, retryAfter: { authz: 1, order: 1 } },
  }
  writeFileSync(join(directory, 'pebble.json'), JSON.stringify(config))
  const extract = run(['create', pebbleImage])
  try {
    // Public CA certificate only. Never extract/read a private key or ACME state.
    run(['cp', `${extract}:/test/certs/pebble.minica.pem`, join(directory, 'pebble-ca.pem')])
  } finally { run(['rm', extract]) }
  const read = (path: string) => readFileSync(new URL(`../deploy/${path}`, import.meta.url), 'utf8')
  writeFileSync(join(directory, 'nginx.conf'), read('nginx.conf')
    .replace('uri https://acme-v02.api.letsencrypt.org/directory;', 'uri http://127.0.0.1:14001/dir;\n        ssl_trusted_certificate /etc/pebble-ca.pem;')
    // Test-only status log: no URI, challenge token, headers or key material.
    .replace('access_log off;', `log_format acme_status '$status';
    map $uri $is_challenge { default 0; ~^/.well-known/acme-challenge/ 1; }
    access_log /tmp/acme-http01.log acme_status if=$is_challenge;`))
  writeFileSync(join(directory, 'Caddyfile'), read('Caddyfile').replace('{\n', '{\n    renew_interval 5s\n    renewal_window_ratio 0.5\n')
    .replace('http://{$FUKULOW_DOMAIN:localhost} {', `http://{$FUKULOW_DOMAIN:localhost} {
    log {
        output file /tmp/acme-http01.log
        format filter {
            wrap json
            fields {
                request delete
                resp_headers delete
            }
        }
    }
    @not_challenge not path /.well-known/acme-challenge/*
    log_skip @not_challenge`)
    .replace('\n\timport browser_headers\n\t@api', `
    tls {
        issuer acme {
            dir http://127.0.0.1:14001/dir
            trusted_roots /etc/pebble-ca.pem
            disable_tlsalpn_challenge
        }
    }
\timport browser_headers
\t@api`))
  return `
  ${profile}:
    depends_on:
      pebble:
        condition: service_started
    ports: !override ["127.0.0.1::443", "127.0.0.1::80"]
    networks:
      edge:
        aliases: [${testDomain}]
    volumes:
      - ${directory}/pebble-ca.pem:/etc/pebble-ca.pem:ro
      - ${directory}/${profile === 'nginx' ? 'nginx.conf:/etc/nginx/templates/nginx.conf.template' : 'Caddyfile:/etc/caddy/Caddyfile'}:ro
  pebble:
    image: ${pebbleImage}
    command: ["-config", "/pebble.json", "-dnsserver", "127.0.0.11:53"]
    environment:
      PEBBLE_VA_NOSLEEP: "1"
      PEBBLE_VA_ALWAYS_VALID: "0"
      PEBBLE_AUTHZREUSE: "0"
    volumes:
      - ${directory}/pebble.json:/pebble.json:ro
    networks: [edge]
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
  acme-directory:
    image: ${nodeImage}
    command: ["node", "/directory.ts"]
    volumes:
      - ${fileURLToPath(new URL('./compose-acme-directory.ts', import.meta.url))}:/directory.ts:ro
      - ${directory}/pebble-ca.pem:/etc/pebble-ca.pem:ro
    network_mode: service:${profile}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:14001/dir').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 1s
      timeout: 3s
      retries: 30
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
`
}

export function challengeResponses(profile: string, container: string, run: (args: string[]) => string): number {
  // This fixture log contains response status only (Caddy also has safe timing
  // fields). Never inspect ordinary proxy logs or files in the ACME state volume.
  const statuses = run(['exec', container, 'cat', '/tmp/acme-http01.log']).split('\n').filter(Boolean)
    .map(line => profile === 'nginx' ? Number(line) : JSON.parse(line).status as number)
  assert.ok(statuses.every(status => status < 300 || status >= 400), 'HTTP-01 must never redirect')
  const validated = statuses.filter(status => status === 200).length
  assert.ok(validated > 0, 'real HTTP-01 validation must return HTTP 200')
  return validated
}

export async function certificate(port: number): Promise<{ serial: string, starts: number, expires: number } | undefined> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port, servername: testDomain, rejectUnauthorized: false })
    socket.setTimeout(2000, () => socket.destroy())
    socket.on('error', () => resolve(undefined))
    socket.on('close', () => resolve(undefined))
    socket.on('secureConnect', () => {
      const peer = socket.getPeerCertificate()
      socket.destroy()
      resolve(peer.serialNumber ? { serial: peer.serialNumber, starts: Date.parse(peer.valid_from), expires: Date.parse(peer.valid_to) } : undefined)
    })
  })
}

export function checkReuse(before: { serial: string, orders: number, accounts: number }, after: { serial: string, orders: number, accounts: number }) {
  assert.ok(before.orders > 0 && before.accounts > 0, 'CA observation must be active')
  assert.deepEqual(after, before, 'restart/recreation must reuse certificate and account without a new order')
}

type ReuseObservation = { serial: string, orders: number, accounts: number }

export function lifetimeRenewalNotBefore(cert: { starts: number, expires: number }): number {
  // nginx-acme 0.4.1 state/certificate.rs: half-life minus 2%; time.rs
  // truncates Timestamp + Duration to whole seconds. Caddy's fixture uses 50%.
  return cert.starts + Math.floor((cert.expires - cert.starts) * 0.48 / 1000) * 1000
}

// Anchor startup completion to the healthy directory and first served persisted
// certificate. Observe three full Caddy scan intervals, checking every sample.
export function checkStartupReuse(before: ReuseObservation, after: ReuseObservation, readyAt: number, observedAt: number): boolean {
  checkReuse(before, after)
  return observedAt >= readyAt + 15_000
}

export function checkLifetimeRenewal(before: ReuseObservation, after: ReuseObservation & { starts: number }, observedAt: number, renewalNotBefore: number): boolean {
  assert.equal(after.accounts, before.accounts, 'renewal reuses persisted account')
  // The fixture sets Caddy to half-life; nginx 0.4.1 uses half-life +/- 2%.
  // Until that window, a delayed startup order or replacement is a failure.
  const { starts, ...observed } = after
  if (observedAt < renewalNotBefore) checkReuse(before, observed)
  if (after.serial === before.serial) return false
  assert.ok(after.orders > before.orders, 'renewal creates a fresh CA order')
  // The CA stamps notBefore at issuance (whole seconds; the window is whole
  // seconds too), so a certificate ordered before the window cannot pass late.
  assert.ok(starts >= renewalNotBefore, 'renewed certificate was issued within the lifetime renewal window')
  return true
}

export function caActivity(log: string): { orders: number, accounts: number } {
  return { orders: (log.match(/POST \/order-plz/g) ?? []).length,
    // newAccount also looks up an existing account (HTTP 200). Count actual
    // stored accounts, not requests to that endpoint.
    accounts: Math.max(0, ...[...log.matchAll(/There are now (\d+) accounts in memory/g)].map(match => Number(match[1]))) }
}

export async function checkCertificateLifecycle(profile: string, dc: (...args: string[]) => string, port: () => number, httpCheck: () => void, run: (args: string[]) => string) {
  const before = await certificate(port())
  assert.ok(before)
  assert.ok(before.expires > Date.now(), 'served certificate must be unexpired')
  assert.ok(before.expires - Date.now() <= 610_000, 'Pebble must issue a short-lived certificate')
  // Pebble 2.8.0 ca/ca.go subtracts one second from the profile validity.
  assert.equal(before.expires - before.starts, 599_000, 'fixture certificate lifetime')
  const renewalNotBefore = lifetimeRenewalNotBefore(before)
  const activity = () => {
    // Aggregate locally; never print or upload raw CA/proxy logs.
    const log = run(['logs', dc('ps', '-q', 'pebble')])
    return caActivity(log)
  }
  const initial = { serial: before.serial, ...activity() }
  challengeResponses(profile, dc('ps', '-q', profile), run)
  for (const action of ['restart', 'recreate']) {
    if (action === 'restart') dc('restart', profile)
    else dc('up', '-d', '--no-deps', '--force-recreate', profile)
    // The directory is loopback-only in the proxy's network namespace. Follow
    // its new namespace after restart/recreation; the CA itself stays running.
    dc('up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '30', 'acme-directory')
    const reused = await poll(`${profile} ${action} certificate`, () => certificate(port()), value => !!value)
    assert.ok(reused)
    const readyAt = Date.now()
    assert.ok(readyAt + 15_000 < renewalNotBefore, 'startup observation must finish before lifetime renewal')
    await poll(`${profile} ${action} startup observation`, async () => {
      httpCheck()
      const served = await certificate(port())
      assert.ok(served, 'persisted certificate must remain available after startup')
      return checkStartupReuse(initial, { serial: served.serial, ...activity() }, readyAt, Date.now())
    }, Boolean, 30_000)
    console.log(`PASS ${profile}: ${action} startup serial/order/account stability observed for 15s`)
  }
  // Both clients schedule automatic renewal within the 10-minute lifetime.
  // Real HTTP-01 validation, with authz reuse disabled, proves renewal/redirect coexistence.
  await poll(`${profile} automatic renewal`, async () => {
    httpCheck()
    const served = await certificate(port())
    assert.ok(served, 'certificate remains available until automatic renewal')
    return checkLifetimeRenewal(initial, { serial: served.serial, starts: served.starts, ...activity() }, Date.now(), renewalNotBefore)
  }, Boolean, Math.min(540_000, before.expires - Date.now()))
  // Recreation removes the first container's status-only log. The current log
  // starts empty and must contain a fresh validation after renewal.
  challengeResponses(profile, dc('ps', '-q', profile), run)
  console.log(`PASS ${profile}: issuance, restart/recreate reuse without new order, automatic HTTP-01 renewal`)
}
