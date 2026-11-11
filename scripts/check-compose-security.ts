// Disposable first-start/restart and proxy-spoofing check; never reads deployment .env.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const project = `fukulow-security-${randomUUID().slice(0, 8)}`
const directory = mkdtempSync(join(tmpdir(), project))
const override = join(directory, 'compose.yml')
const image = process.env.CHECK_COMPOSE_IMAGE || `${project}-app`
const env = { PATH: process.env.PATH, POSTGRES_PASSWORD: 'compose-e2e-db-test-only',
  FUKULOW_SETUP_TOKEN: 'compose-e2e-setup-test-only',
  // Per-run private subnets; restart checks use a separate second-octet range.
  FUKULOW_EDGE_PREFIX: process.env.CHECK_EDGE_PREFIX || `10.${randomInt(128, 192)}.${randomInt(256)}`,
  FUKULOW_COOKIE_SECURE: 'false' }
const helper = `${project}-untrusted`
const compose = ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'compose.yml', '-f', override]
const run = (args: string[], input?: string) => execFileSync('docker', args, { cwd, env, input, encoding: 'utf8', timeout: 180_000 }).trim()
const dc = (...args: string[]) => run([...compose, ...args])
const owner = { email: 'compose-owner@example.test', password: 'compose-owner-password-test-only' }
writeFileSync(override, `services:
  app:
    image: ${image}
    ports: ["127.0.0.1::8080"]
    networks:
      edge:
        gw_priority: 1
  caddy:
    ports: !override ["127.0.0.1::443", "127.0.0.1::80"]
  nginx:
    ports: !override ["127.0.0.1::80"]
`)

async function check(profile: string) {
  const proxy = (...args: string[]) => dc('--profile', profile, ...args)
  try {
    proxy('up', '-d', '--no-build', '--wait')
    const port = proxy('port', profile, profile === 'caddy' ? '443' : '80')
    const url = `${profile === 'caddy' ? 'https' : 'http'}://${port.replace('127.0.0.1:', 'localhost:')}`
    const request = (path: string, data?: unknown, forwarded?: string, baseUrl = url) => {
      const args = ['--insecure', '--silent', '--show-error', '--max-time', '10', '-w', '\n%{http_code}']
      if (data !== undefined) args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(data))
      if (forwarded) args.push('-H', `X-Forwarded-For: ${forwarded}`)
      const response = execFileSync('curl', [...args, baseUrl + path], { encoding: 'utf8' }).trim()
      const boundary = response.lastIndexOf('\n')
      return { status: Number(response.slice(boundary + 1)), body: response.slice(0, boundary) }
    }
    for (let n = 0; ; n++) {
      try { if (request('/api/v1/health').status === 200) break } catch { /* app may still be migrating */ }
      if (n === 59) throw new Error('App did not become healthy')
      await delay(1000)
    }
    const app = proxy('ps', '-q', 'app')
    const [state] = JSON.parse(run(['inspect', app]))
    assert.equal(state.HostConfig.PortBindings['8080/tcp'][0].HostIp, '127.0.0.1')
    assert.deepEqual(request('/api/v1/setup'), { status: 200, body: '{"setup_required":true}' })
    const setup = { ...owner, organization_name: 'Compose', name: 'Owner' }
    for (const token of [undefined, 'wrong-token-test-only']) {
      assert.equal(request('/api/v1/setup', { ...setup, setup_token: token }).status, 401)
    }
    assert.equal(request('/api/v1/setup', { ...setup, setup_token: env.FUKULOW_SETUP_TOKEN }).status, 201)
    assert.equal(request('/api/v1/session', owner).status, 200)

    // This helper joins only backend for the test. Its socket peer is untrusted even
    // though the configured header is present; changing spoofed IPs cannot escape 429.
    run(['run', '--rm', '--name', helper, '-i', '--network', `${project}_backend`,
      'node:26.13.0-slim', 'node', '--input-type=module'], `
      import assert from 'node:assert/strict';
      const request = async (email, ip, password = 'wrong-password-test-only') => {
        const response = await fetch('http://app:8080/api/v1/session', { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
          body: JSON.stringify({ email, password }) });
        await response.text(); return response;
      };
      for (let n = 1; n <= 20; n++) assert.equal((await request('direct' + n + '@example.test', '198.51.100.' + n)).status, 401);
      const denied = await request(${JSON.stringify(owner.email)}, '203.0.113.99', ${JSON.stringify(owner.password)});
      assert.equal(denied.status, 429); assert.ok(denied.headers.get('Retry-After'));
    `)
    // The proxy's real client budget stays usable after the untrusted peer is exhausted.
    assert.equal(request('/api/v1/session', owner, '198.51.100.222').status, 200)
    // Forging a header through the public proxy cannot rotate that real client's bucket.
    for (let n = 1; n <= 20; n++) {
      assert.equal(request('/api/v1/session', { email: `proxy${n}@example.test`, password: 'wrong-password-test-only' }, `203.0.113.${n}`).status, 401)
    }
    assert.equal(request('/api/v1/session', owner, '192.0.2.99').status, 429)
    // Two real source IPs behind the same trusted proxy must have separate budgets.
    // Temporarily attach test clients to edge; the shipped topology has no such services.
    for (const [host, exhaust] of [[5, true], [6, false]] as const) {
      run(['run', '--rm', '--name', helper, '-i', '--network', `${project}_edge`, '--ip', `${env.FUKULOW_EDGE_PREFIX}.${host}`,
        'node:26.13.0-slim', 'node', '--input-type=module'], `
        import assert from 'node:assert/strict';
        import { request } from 'node:${profile === 'caddy' ? 'https' : 'http'}';
        const signIn = (input) => new Promise((resolve, reject) => {
          const body = JSON.stringify(input);
          const req = request({ hostname: '${env.FUKULOW_EDGE_PREFIX}.2', port: ${profile === 'caddy' ? 443 : 80},
            servername: 'localhost', rejectUnauthorized: false, path: '/api/v1/session', method: 'POST',
            headers: { Host: 'localhost', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
          req.on('error', reject); req.end(body);
        });
        if (${exhaust}) for (let n = 1; n <= 20; n++) assert.equal(await signIn({email: 'edge' + n + '@example.test', password: 'wrong-password-test-only'}), 401);
        assert.equal(await signIn(${JSON.stringify(owner)}), ${exhaust ? 429 : 200});
      `)
    }
    async function restartApp() {
      proxy('restart', 'app')
      for (let n = 0; ; n++) {
        try { if (request('/api/v1/session', owner).status === 200) break } catch { /* restart */ }
        if (n === 59) throw new Error('Sign-in did not recover after restart')
        await delay(1000)
      }
    }
    // Reset budgets first: the host may appear as the same client IP through
    // the public proxy and the debug publication. Prefer edge as its gateway.
    await restartApp()
    const debugUrl = `http://${proxy('port', 'app', '8080')}`
    assert.equal(request('/api/v1/session', owner, undefined, debugUrl).status, 200)
    for (let n = 1; n <= 20; n++) {
      assert.equal(request('/api/v1/session', { email: `debug${n}@example.test`, password: 'wrong-password-test-only' },
        `198.51.100.${n}`, debugUrl).status, 401)
    }
    assert.equal(request('/api/v1/session', owner, '192.0.2.199', debugUrl).status, 429)
    await restartApp()
    assert.equal(request('/api/v1/setup').body, '{"setup_required":false}')
    console.log(`PASS ${profile}: token, sign-in, backend/public/debug-port spoofing, independent client budgets, restart, retained setup`)
  } finally {
    spawnSync('docker', ['rm', '-f', helper], { cwd, env, stdio: 'ignore' })
    proxy('down', '-v', '--remove-orphans')
  }
}

try {
  console.log(`project=${project} edge=${env.FUKULOW_EDGE_PREFIX}.0/29`)
  if (!process.env.CHECK_COMPOSE_IMAGE) {
    console.log('Building disposable security-check image...')
    execFileSync('docker', [...compose, 'build', 'app'], { cwd, env, stdio: 'inherit' })
  }
  for (const token of [undefined, '', ' \t', '\u2003', 'setup-token-local-test-only', ' setup-token-local-test-only ']) {
    const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '-e', 'FUKULOW_COOKIE_SECURE=false',
      ...(token === undefined ? [] : ['-e', `FUKULOW_SETUP_TOKEN=${token}`]), image], { cwd, env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /FUKULOW_SETUP_TOKEN must/)
    assert.equal(result.stdout, '')
  }
  await check('caddy')
  await check('nginx')
} finally {
  if (!process.env.CHECK_COMPOSE_IMAGE) run(['image', 'rm', image])
  rmSync(directory, { recursive: true, force: true })
}
