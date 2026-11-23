// Disposable TLS/WebSocket and forwarding checks with the shipped external proxy examples.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nodeImage, poll } from './compose-acme.ts'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const image = process.env.CHECK_COMPOSE_IMAGE || 'fukulow-app'
const domain = 'chat.example.com'
const owner = { email: 'owner@example.test', password: 'correct horse battery' }
const traefikImage = 'traefik:v3.7.1@sha256:6b9cbca6fac42ab0075f5437d8dc1685cfd188626d8d515839ea94f8b6271c42'
const cloudflaredImage = 'cloudflare/cloudflared:2026.11.0@sha256:b94b96edf2c9c4360f8879c8580cfaa99077f19c849ec595ca2f711b27d4f344'
const nginxImage = readFileSync(join(cwd, 'compose.yml'), 'utf8').match(/^    image: (nginx:\S+)$/m)?.[1]
assert.ok(nginxImage, 'reuse the bundled nginx image pin')

function docker(env: Record<string, string | undefined>, args: string[], input?: string) {
  const result = spawnSync('docker', args, { cwd, env, input, encoding: 'utf8', timeout: 180_000 })
  assert.equal(result.status, 0, `docker ${args[0]} failed (output suppressed)`)
  return result.stdout.trim()
}

function cloudflared() {
  const config = join(cwd, 'deploy/external-cloudflared.yml')
  const run = (...args: string[]) => docker({ PATH: process.env.PATH }, ['run', '--rm', '--network', 'none',
    '-v', `${config}:/config.yml:ro`, cloudflaredImage, 'tunnel', '--config', '/config.yml', 'ingress', ...args])
  run('validate')
  assert.match(run('rule', `https://${domain}/api/v1/orgs/test/ws`), /service: http:\/\/127\.0\.0\.1:8080/)
  assert.match(run('rule', 'https://foreign.example/api/v1/health'), /service: http_status:404/)
  console.log('PASS Cloudflare Tunnel: ingress validates and selects the origin for the configured Host only')
}

async function check(proxy: 'nginx' | 'traefik') {
  const project = `fukulow-external-${randomUUID().slice(0, 8)}`
  const directory = mkdtempSync(join(process.env.CHECK_COMPOSE_WORK_DIR || tmpdir(), project))
  const override = join(directory, 'compose.yml')
  const env = { PATH: process.env.PATH, COMPOSE_PROFILES: 'none', FUKULOW_VERSION: '0.0.0-dev',
    FUKULOW_DOMAIN: domain, FUKULOW_EDGE_PREFIX: `10.${randomInt(32, 64)}.${randomInt(256)}`, FUKULOW_PUBLISH_PORT: '0',
    FUKULOW_COOKIE_SECURE: 'false', FUKULOW_TRUSTED_PROXIES: '127.0.0.1', FUKULOW_CLIENT_IP_HEADER: 'X-Forwarded-For',
    POSTGRES_PASSWORD: 'external-proxy-db-test-only', POSTGRES_APP_PASSWORD: 'external-proxy-app-test-only',
    FUKULOW_SETUP_TOKEN: 'external-proxy-setup-test-only' }
  const run = (args: string[], input?: string) => docker(env, args, input)
  const dc = (...args: string[]) => run(['compose', '--env-file', '/dev/null', '-p', project,
    '-f', 'compose.yml', '-f', 'compose.external-proxy.yml', '-f', override, ...args])
  const name = `${project}-${proxy}`
  const cert = join(directory, `${domain}.crt`)
  const key = join(directory, `${domain}.key`)
  try {
    // The fixture shares the app's private network namespace so the checked-in examples can
    // dial loopback unchanged. Only fixture ports 80/443 are added to exercise their TLS edge.
    writeFileSync(override, `services:
  app:
    image: ${image}
    ports: ["127.0.0.1::80", "127.0.0.1::443"]
  migrate:
    image: ${image}
`)
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-keyout', key, '-out', cert, '-subj', `/CN=${domain}`, '-addext', `subjectAltName=DNS:${domain}`], { stdio: 'ignore' })
    dc('up', '-d', '--no-build', '--wait', '--wait-timeout', '90')
    const app = dc('ps', '-q', 'app')
    const port = (target: number) => Number(dc('port', 'app', String(target)).split(':').at(-1))
    const common = ['run', '-d', '--name', name, '--network', `container:${app}`,
      '-v', `${cert}:/etc/nginx/tls/${domain}.crt:ro`, '-v', `${key}:/etc/nginx/tls/${domain}.key:ro`]
    if (proxy === 'nginx') {
      const config = join(directory, 'nginx.conf')
      writeFileSync(config, 'events {}\nhttp { access_log off; include /example.conf; }\n')
      run([...common, '-v', `${config}:/fixture.conf:ro`, '-v', `${cwd}/deploy/external-nginx.conf:/example.conf:ro`,
        nginxImage, 'nginx', '-g', 'daemon off;', '-c', '/fixture.conf'])
    } else {
      const tls = join(directory, 'tls.yml')
      writeFileSync(tls, `tls:\n  certificates:\n    - certFile: /etc/nginx/tls/${domain}.crt\n      keyFile: /etc/nginx/tls/${domain}.key\n`)
      run([...common, '-v', `${tls}:/fixture/tls.yml:ro`, '-v', `${cwd}/deploy/external-traefik.yml:/fixture/proxy.yml:ro`,
        traefikImage, '--providers.file.directory=/fixture', '--entrypoints.web.address=:80', '--entrypoints.websecure.address=:443'])
    }

    const ca = readFileSync(cert, 'utf8')
    const ports = { http: port(80), https: port(443), upstream: port(8080) }
    function request(path: string, { via = 'https' as keyof typeof ports, headers = {} as OutgoingHttpHeaders,
      data = undefined as unknown, trustCa = true } = {}) {
      return new Promise<{ status: number, headers: typeof headers, body: string }>((resolve, reject) => {
        const req = (via === 'https' ? httpsRequest : httpRequest)({ path, hostname: '127.0.0.1', port: ports[via],
          servername: domain, ca: trustCa ? ca : undefined, method: data === undefined ? 'GET' : 'POST', agent: false,
          headers: { Host: domain, 'Content-Type': 'application/json', ...headers } }, res => {
          let body = ''
          res.setEncoding('utf8').on('data', chunk => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
          res.on('error', reject)
        })
        req.setTimeout(5_000, () => req.destroy(new Error('HTTP request timeout')))
        req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 0, headers: res.headers, body: '' }) })
        req.on('error', reject)
        req.end(data === undefined ? undefined : JSON.stringify(data))
      })
    }

    const health = '/api/v1/health'
    await poll(`${proxy} verified HTTPS`, () => request(health).catch(() => undefined), result => result?.body === 'ok')
    await assert.rejects(request(health, { trustCa: false }), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    const redirect = await request(health, { via: 'http' })
    assert.ok([301, 308].includes(redirect.status))
    assert.equal(redirect.headers.location, `https://${domain}${health}`)
    const foreign = { Host: 'foreign.example', 'X-Forwarded-Host': domain }
    assert.ok([404, 421].includes((await request(health, { headers: foreign })).status))
    assert.equal((await request(health, { via: 'upstream', headers: foreign })).status, 421)
    assert.equal((await request('/api/v1/ready', { headers: { 'X-Forwarded-For': '127.0.0.1' } })).status, 404)
    assert.match(String((await request(health)).headers['strict-transport-security']), /max-age=31536000/)
    assert.equal((await request('/api/v1/setup', { data: { ...owner, organization_name: 'Acme', name: 'Alice',
      setup_token: env.FUKULOW_SETUP_TOKEN } })).status, 201)
    const session = '/api/v1/session'
    const signedIn = await request(session, { data: owner, headers: { 'X-Forwarded-Proto': 'http' } })
    assert.equal(signedIn.status, 200)
    const cookie = (signedIn.headers['set-cookie'] as string[]).find(value => value.startsWith('__Host-'))
    assert.ok(cookie)
    assert.match(cookie, /;\s*Secure(?:;|$)/i)
    const auth = cookie.split(';')[0]
    const me = await request('/api/v1/me', { headers: { Cookie: auth } })
    assert.equal(me.status, 200)
    const org = JSON.parse(me.body).organizations[0].organization_id
    const ws = `/api/v1/orgs/${org}/ws`
    const upgrade = { Cookie: auth, Connection: 'Upgrade', Upgrade: 'websocket',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' }
    for (const Origin of ['https://foreign.example', `http://${domain}`]) {
      const denied = await request(ws, { headers: { ...upgrade, Origin } })
      assert.equal(denied.status, 403)
      assert.equal(JSON.parse(denied.body).error, 'origin_not_allowed')
    }
    assert.equal((await request(ws, { headers: { ...upgrade, Origin: `https://${domain}` } })).status, 101)

    for (let n = 1; n <= 20; n++) {
      const failure = await request(session, { headers: { 'X-Forwarded-For': `192.0.2.${n}` },
        data: { email: `public${n}@example.test`, password: 'wrong-password-test-only' } })
      assert.equal(failure.status, 401)
    }
    const limited = await request(session, { headers: { 'X-Forwarded-For': '192.0.2.99' }, data: owner })
    assert.equal(limited.status, 429)
    assert.ok(limited.headers['retry-after'])
    // This client's socket IP differs from the test runner's. After exhausting the runner's
    // budget, sign-in works through the trusted proxy. Direct to the app the same client
    // is untrusted and cannot rotate its own budget with forwarded IP values.
    run(['run', '--rm', '-i', '--network', `${project}_backend`, '-v', `${cert}:/ca.crt:ro`, nodeImage, 'node', '--input-type=module'], `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { request as http } from 'node:http';
      import { request as https } from 'node:https';
      const owner = ${JSON.stringify(owner)};
      const signIn = (data, forwardedFor, tls = false) => new Promise((resolve, reject) => {
        const req = (tls ? https : http)({ hostname: 'app', port: tls ? 443 : 8080, servername: '${domain}',
          ca: readFileSync('/ca.crt'), method: 'POST', path: '${session}',
          headers: { Host: '${domain}', 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor } }, res => {
          res.resume(); res.on('end', () => resolve(res)); res.on('error', reject);
        });
        req.setTimeout(5000, () => req.destroy(new Error('sign-in timeout')));
        req.on('error', reject);
        req.end(JSON.stringify(data));
      });
      assert.equal((await signIn(owner, '198.51.100.99', true)).statusCode, 200);
      for (let n = 1; n <= 20; n++) {
        const failure = await signIn({ email: 'direct' + n + '@example.test', password: 'wrong-password-test-only' }, '198.51.100.' + n);
        assert.equal(failure.statusCode, 401);
      }
      const denied = await signIn(owner, '198.51.100.100');
      assert.equal(denied.statusCode, 429);
      assert.ok(denied.headers['retry-after']);
    `)
    console.log(`PASS ${proxy}: verified HTTPS, redirect/HSTS, private readiness, Host and Origin denials, Secure cookies, WSS and client-IP trust`)
  } finally {
    spawnSync('docker', ['rm', '-f', name], { cwd, env, timeout: 20_000, stdio: 'ignore' })
    try { dc('down', '-v', '--remove-orphans') } finally { rmSync(directory, { recursive: true, force: true }) }
  }
}

cloudflared()
for (const proxy of ['nginx', 'traefik'] as const) await check(proxy)
