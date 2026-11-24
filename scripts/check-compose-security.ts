// Disposable first-start/restart and proxy-spoofing check; never reads deployment .env.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acmeFixture, buildRenewalPebble, certificate, challengeResponses, checkCertificateLifecycle, checkVerifiedTls, nodeImage, pebbleImage, pebbleIssuingRoot, poll, testDomain } from './compose-acme.ts'
import { fileURLToPath } from 'node:url'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { checkAssetCompression } from './asset-compression.ts'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const project = process.env.CHECK_COMPOSE_PROJECT || `fukulow-security-${randomUUID().slice(0, 8)}`
assert.match(project, /^fukulow-(?:security|e2e)-[a-z0-9][a-z0-9_-]+$/)
const directory = mkdtempSync(join(process.env.CHECK_COMPOSE_WORK_DIR || tmpdir(), project))
const override = join(directory, 'compose.yml')
const image = process.env.CHECK_COMPOSE_IMAGE || `${project}-app`
const env = { PATH: process.env.PATH, POSTGRES_PASSWORD: 'compose-e2e-db-test-only',
  POSTGRES_APP_PASSWORD: 'compose-e2e-app-test-only',
  FUKULOW_SETUP_TOKEN: 'compose-e2e-setup-test-only',
  // Per-run private subnets; restart checks use a separate second-octet range.
  FUKULOW_EDGE_PREFIX: process.env.CHECK_EDGE_PREFIX || `10.${randomInt(128, 192)}.${randomInt(256)}`,
  FUKULOW_COOKIE_SECURE: 'true', FUKULOW_DOMAIN: testDomain,
  // Replaced by the image override below; a published-image check passes its real version.
  FUKULOW_VERSION: process.env.FUKULOW_VERSION || '0.0.0-dev' }
const helper = `${project}-untrusted`
// Only a source build needs the development override; a supplied image runs on compose.yml alone.
const files = process.env.CHECK_COMPOSE_IMAGE ? ['-f', 'compose.yml'] : ['-f', 'compose.yml', '-f', 'compose.dev.yml']
const compose = ['compose', '--env-file', '/dev/null', '-p', project, ...files, '-f', override]
const run = (args: string[], input?: string) => {
  const result = spawnSync('docker', args, { cwd, env, input, encoding: 'utf8', timeout: 180_000, stdio: 'pipe' })
  // Never forward raw container/CA logs, including stderr, into CI diagnostics.
  assert.equal(result.status, 0, `docker ${args[0]} failed (output suppressed)`)
  return (result.stdout + (args[0] === 'logs' ? result.stderr : '')).trim()
}
const dc = (...args: string[]) => run([...compose, ...args])
const lifecycle = process.env.CHECK_COMPOSE_ACCEPTANCE === '1' || process.env.CHECK_COMPOSE_RENEWAL === '1'
// Only the renewal check depends on Pebble never reusing an authorization (#939).
let ca = pebbleImage
const owner = { email: 'owner@example.com', password: 'correct horse battery' }
const permissionsPolicy = 'accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()'
const baseOverride = `services:
  migrate:
    image: ${image}
  app:
    image: ${image}
    ports: ["127.0.0.1::8080"]
    networks:
      edge:
        gw_priority: 1
`
writeFileSync(override, baseOverride)

async function check(profile: string) {
  const proxy = (...args: string[]) => dc('--profile', profile, ...args)
  try {
    writeFileSync(override, baseOverride + acmeFixture(directory, profile, run, { ca }))
    proxy('up', '-d', '--no-build', '--wait')
    const tlsPort = () => Number(proxy('port', profile, '443').split(':').at(-1))
    let url = `https://${testDomain}:${tlsPort()}`
    const resolveHost = ['--noproxy', '*', '--connect-to', `${testDomain}::127.0.0.1:`]
    const curl = (args: string[]) => execFileSync('curl', [...resolveHost, ...args], { encoding: 'utf8', timeout: 15_000 }).trim()
    await poll('TLS issuance', () => certificate(tlsPort()), value => !!value)
    // Normal path with verification on: Pebble's issuing root is trusted and the
    // served chain and hostname are checked for ${testDomain}.
    const issuingRoot = pebbleIssuingRoot(proxy)
    const untrustedCa = readFileSync(join(directory, 'pebble-ca.pem'), 'utf8')
    console.log(`PASS ${profile}: verified TLS chain and hostname, serial ${await checkVerifiedTls(tlsPort(), issuingRoot, untrustedCa)}`)
    const request = (path: string, data?: unknown, forwarded?: string, baseUrl = url, token?: string) => {
      const args = ['--insecure', '--silent', '--show-error', '--max-time', '10', '-w', '\n%{http_code}']
      if (data !== undefined) args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(data))
      if (forwarded) args.push('-H', `X-Forwarded-For: ${forwarded}`)
      if (token) args.push('-H', `Authorization: Bearer ${token}`)
      const response = curl([...args, baseUrl + path])
      const boundary = response.lastIndexOf('\n')
      return { status: Number(response.slice(boundary + 1)), body: response.slice(0, boundary) }
    }
    await poll('HTTPS health', () => request('/api/v1/health'), value => value.status === 200)
    function checkBrowserHeaders(output: string, path: string) {
      for (const [name, value] of [['permissions-policy', permissionsPolicy], ['cross-origin-opener-policy', 'same-origin']]) {
        const values = output.split(/\r?\n/).filter(line => line.toLowerCase().startsWith(`${name}:`)).map(line => line.slice(line.indexOf(':') + 1).trim())
        assert.deepEqual(values, [value], `${profile} ${path}: ${name}`)
      }
    }
    function checkHttp() {
      const http = `http://${testDomain}:${proxy('port', profile, '80').split(':').at(-1)}`
      for (const path of ['/', '/api/v1/health', '/api/v1/ready?check=1']) {
        const headers = curl(['-sI', '--max-time', '5', http + path])
        assert.match(headers, /^HTTP\/\S+ 308\b/)
        const locations = headers.split(/\r?\n/).filter(line => /^location:/i.test(line)).map(line => line.slice(line.indexOf(':') + 1).trim())
        assert.deepEqual(locations, [`https://${testDomain}${path}`])
        assert.doesNotMatch(headers, /strict-transport-security:/i)
        checkBrowserHeaders(headers, path)
      }
      const challenge = curl(['-sI', '--max-time', '5', http + '/.well-known/acme-challenge/not-an-active-token'])
      assert.match(challenge, /^HTTP\/\S+ 404\b/)
      assert.doesNotMatch(challenge, /location:|strict-transport-security:/i)
      checkBrowserHeaders(challenge, 'HTTP-01 fallback')
    }
    checkHttp()
    async function checkRejectedHost(tls: boolean, host: string, servername?: string, absoluteForm = false) {
      const response = await new Promise<{ status: number, location?: string, csp?: string } | undefined>((resolve, reject) => {
        const req = (tls ? httpsRequest : httpRequest)({ hostname: '127.0.0.1',
          port: tls ? tlsPort() : Number(proxy('port', profile, '80').split(':').at(-1)),
          servername, rejectUnauthorized: false, headers: { Host: host },
          path: absoluteForm ? `https://${testDomain}/api/v1/health` : '/api/v1/health', agent: false }, res => {
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, csp: res.headers['content-security-policy'] }))
        })
        req.setTimeout(5000, () => req.destroy(new Error('Host rejection probe timed out')))
        req.on('error', (error: NodeJS.ErrnoException) => {
          // nginx 444/Caddy abort close the socket; unknown SNI fails TLS.
          if (error.code === 'ECONNRESET' || (tls && error.code === 'EPROTO')) resolve(undefined)
          else reject(error)
        })
        req.end()
      })
      if (response) {
        if (absoluteForm && profile === 'caddy') {
          // Go canonicalizes absolute-form authority into Request.Host before
          // Caddy routing. The conflicting raw Host must never reach the app.
          assert.equal(response.status, 200)
          assert.match(response.csp ?? '', /wss:\/\/fukulow\.test(?:[ ;]|$)/)
          assert.ok(!response.csp?.includes(host), 'absolute-form authority must replace the foreign Host')
          return
        }
        assert.ok(response.status >= 400 && response.status < 500, `${profile}: unknown Host/SNI must be rejected`)
        assert.equal(response.location, undefined, 'foreign Host must never control a redirect')
      }
    }
    for (const host of ['attacker.example', '127.0.0.1']) {
      await checkRejectedHost(false, host)
      await checkRejectedHost(true, host, testDomain)
    }
    await checkRejectedHost(true, testDomain, 'attacker.example')
    await checkRejectedHost(true, testDomain, '')
    await checkRejectedHost(true, 'attacker.example', testDomain, true)
    challengeResponses(profile, proxy('ps', '-q', profile), run)
    function checkState() {
      if (profile !== 'nginx') return
      const container = proxy('ps', '-q', profile)
      assert.match(run(['exec', container, 'cat', '/proc/1/status']), /^Uid:\s+101\s+101\s+101\s+101$/m)
      assert.equal(run(['exec', container, 'stat', '-c', '%U:%G:%a', '/var/lib/nginx/acme']), 'nginx:nginx:700')
      // Metadata only: state content and private filenames never enter diagnostics.
      assert.equal(run(['exec', container, 'sh', '-c', 'find /var/lib/nginx/acme -mindepth 1 ! -user nginx -print -quit | wc -l']), '0')
      assert.equal(run(['exec', container, 'sh', '-c', 'find /var/lib/nginx/acme -mindepth 1 -perm /077 -print -quit | wc -l']), '0')
    }
    checkState()
    if (profile === 'nginx') {
      const reference = run(['inspect', '--format', '{{.Config.Image}}', proxy('ps', '-q', profile)])
      run(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', reference, '-c', 'test ! -e /var/lib/nginx/acme'])
    }
    if (lifecycle) {
      await checkCertificateLifecycle(profile, proxy, tlsPort, checkHttp, run)
      // The renewed certificate must verify the same way.
      console.log(`PASS ${profile}: verified renewed TLS chain and hostname, serial ${await checkVerifiedTls(tlsPort(), issuingRoot, untrustedCa)}`)
      checkState()
      url = `https://${testDomain}:${tlsPort()}`
      assert.equal(curl(['-sk', url + '/api/v1/health']), 'ok')
    }
    const app = proxy('ps', '-q', 'app')
    function checkHeaders(path: string, status: number | number[], baseUrl = url) {
      const output = curl(['-sI', '--insecure', '--show-error', '--max-time', '10', baseUrl + path])
      const statuses = [status].flat().join('|')
      assert.match(output, new RegExp(`^HTTP/\\S+ (?:${statuses})\\b`))
      if (baseUrl === url) assert.match(output, /strict-transport-security: max-age=31536000/i)
      checkBrowserHeaders(output, path)
      console.log(`curl -sI --insecure ${baseUrl + path}\n${output.split(/\r?\n/).filter(line => /^(HTTP\/|permissions-policy:|cross-origin-opener-policy:)/i.test(line)).join('\n')}`)
    }
    for (const [path, status] of [['/', 200], ['/api/v1/health', 200], ['/api/v1/missing', 404], ['/api/v1/ready', 404], ['/api/v1/ready?check=1', 404]] as const) checkHeaders(path, status)
    assert.equal(request('/api/v1/ready').status, 404, 'readiness must stay internal')
    assert.equal(request('/api/v1/ready?check=1').status, 404, 'query strings must not bypass the exact-path block')
    assert.deepEqual(request('/api/v1/health'), { status: 200, body: 'ok' })
    function checkCacheAndCompression(path: string) {
      const response = curl(['-sk', '-D', '-', '-o', '/dev/null', '-H', 'Accept-Encoding: gzip', url + path])
      if (path.startsWith('/api')) {
        assert.doesNotMatch(response, /content-encoding:/i, `${profile} API compression exclusion`)
        assert.match(response, /cache-control: no-store/i)
      } else {
        assert.match(response, /cache-control: no-cache/i)
      }
    }
    for (const path of ['/', '/fallback-route', '/api', '/api/', '/api/v1/health', '/api/v1/missing', '/api/v1/ready', '/api/v1/ready?check=1']) checkCacheAndCompression(path)
    const html = curl(['-sk', url + '/'])
    const asset = html.match(/src="([^"]+\.js)"/)?.[1]
    assert.ok(asset, 'built Vite entry must exist')
    const rootHeaders = curl(['-sk', '-D', '-', '-o', '/dev/null', url + '/'])
    assert.match(rootHeaders, /script-src 'self' 'wasm-unsafe-eval';/)
    assert.doesNotMatch(rootHeaders, /'unsafe-eval'/)
    const glue = html.match(/href="([^"]*sync-wasm-[^"]+\.js)"/)?.[1]
    assert.ok(glue, 'manifest glue chunk is module-preloaded')
    const glueSource = curl(['-sk', url + glue])
    const wasm = glueSource.match(/assets\/fukulow_client_core_bg-[\w-]+\.wasm/)?.[0]
    assert.ok(wasm, 'glue references emitted wasm')
    for (const path of [glue, '/' + wasm]) {
      const headers = curl(['-sk', '-D', '-', '-o', '/dev/null', url + path])
      assert.match(headers, /cache-control: public, max-age=31536000, immutable/i)
      if (path.endsWith('.wasm')) assert.match(headers, /content-type: application\/wasm/i)
    }
    const compression = checkAssetCompression((path, encoding) => {
      const headers = join(directory, 'asset-headers')
      const body = execFileSync('curl', [...resolveHost, '-skS', '--max-time', '15', '-D', headers,
        ...(encoding === undefined ? [] : ['-H', `Accept-Encoding: ${encoding}`]), url + path])
      return { headers: readFileSync(headers, 'utf8'), body }
    })
    console.log(`PASS ${profile}: Brotli/identity negotiation, exact decoded bytes, MIME/cache and Vary for every discovered bundle asset ${JSON.stringify(compression)}`)
    run(['exec', app, 'fukulow-server', 'probe'])
    const [state] = JSON.parse(run(['inspect', app]))
    for (const container of [app, proxy('ps', '-aq', 'migrate')]) {
      const [actual] = JSON.parse(run(['inspect', container]))
      assert.equal(actual.HostConfig.ReadonlyRootfs, true)
      assert.deepEqual(actual.HostConfig.CapDrop, ['ALL'])
      assert.deepEqual(actual.HostConfig.SecurityOpt, ['no-new-privileges:true'])
      assert.equal(actual.HostConfig.Privileged, false)
      assert.deepEqual(actual.HostConfig.CapAdd ?? [], [])
      assert.deepEqual(actual.Mounts, [], 'no writable mounts or tmpfs needed')
      assert.equal(run(['diff', container]), '', 'no runtime filesystem writes')
      if (container !== app) assert.equal(actual.State.ExitCode, 0, 'read-only migration succeeded')
    }
    const processStatus = run(['exec', app, 'cat', '/proc/1/status'])
    assert.match(processStatus, /^NoNewPrivs:\s+1$/m)
    for (const capability of ['CapPrm', 'CapEff', 'CapBnd']) assert.match(processStatus, new RegExp(`^${capability}:\\s+0+$`, 'm'))
    assert.equal(state.State.Health.Status, 'healthy')
    assert.equal(state.Config.User, '10001:10001')
    assert.equal(run(['exec', app, 'id', '-u']), '10001')
    assert.match(run(['exec', app, 'cat', '/proc/1/status']), /^Uid:\s+10001\s+10001\s+10001\s+10001$/m)
    run(['exec', app, 'sh', '-c', 'test ! -w /usr/local/bin/fukulow-server'])
    assert.deepEqual(state.HostConfig.LogConfig, { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } })
    assert.equal(state.HostConfig.PortBindings['8080/tcp'][0].HostIp, '127.0.0.1')
    assert.deepEqual(request('/api/v1/setup'), { status: 200, body: '{"setup_required":true}' })
    const setup = { ...owner, organization_name: 'Acme', name: 'Alice' }
    for (const token of [undefined, 'wrong-token-test-only']) {
      assert.equal(request('/api/v1/setup', { ...setup, setup_token: token }).status, 401)
    }
    if (process.env.CHECK_COMPOSE_ACCEPTANCE === '1') {
      execFileSync('npm', ['--prefix', 'web', 'run', 'e2e:compose'], { cwd, stdio: 'inherit',
        env: { ...process.env, E2E_BASE_URL: `https://${testDomain}:${tlsPort()}`,
          E2E_TEST_DOMAIN: testDomain, E2E_SETUP_TOKEN: env.FUKULOW_SETUP_TOKEN,
          E2E_ROTATE_NETWORK: `${project}_backend`, E2E_ROTATE_IMAGE: image } })
    } else assert.equal(request('/api/v1/setup', { ...setup, setup_token: env.FUKULOW_SETUP_TOKEN }).status, 201)
    assert.equal(request('/api/v1/session', owner).status, 200)
    const native = request('/api/v1/native/session', owner)
    assert.equal(native.status, 200)
    const session = JSON.parse(native.body)
    const me = request('/api/v1/me', undefined, undefined, url, session.token)
    assert.equal(me.status, 200)
    const organization = JSON.parse(me.body).organizations[0].organization_id
    const authenticated = (path: string, data?: unknown) => request(`/api/v1/orgs/${organization}${path}`, data, undefined, url, session.token)
    const created = authenticated('/channels', { name: 'Read-only check', visibility: 'public' })
    assert.equal(created.status, 201)
    const channel = JSON.parse(created.body).id
    const messagesPath = `/channels/${channel}/messages`
    assert.equal(authenticated(messagesPath, { body: 'Fresh read-only send', client_message_id: randomUUID() }).status, 201)

    // This helper joins only backend for the test. Its socket peer is untrusted even
    // though the configured header is present; changing spoofed IPs cannot escape 429.
    run(['run', '--rm', '--name', helper, '-i', '--network', `${project}_backend`,
      nodeImage, 'node', '--input-type=module'], `
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
        nodeImage, 'node', '--input-type=module'], `
        import assert from 'node:assert/strict';
        import { request } from 'node:https';
        const signIn = (input) => new Promise((resolve, reject) => {
          const body = JSON.stringify(input);
          const req = request({ hostname: '${env.FUKULOW_EDGE_PREFIX}.2', port: 443,
            servername: '${testDomain}', rejectUnauthorized: false, path: '/api/v1/session', method: 'POST',
            headers: { Host: '${testDomain}', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
            res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
          req.on('error', reject); req.end(body);
        });
        if (${exhaust}) for (let n = 1; n <= 20; n++) assert.equal(await signIn({email: 'edge' + n + '@example.test', password: 'wrong-password-test-only'}), 401);
        assert.equal(await signIn(${JSON.stringify(owner)}), ${exhaust ? 429 : 200});
      `)
    }
    async function restartApp() {
      proxy('restart', 'app')
      await poll('sign-in recovery after restart', () => request('/api/v1/session', owner).status, status => status === 200)
    }
    // Reset budgets first: the host may appear as the same client IP through
    // the public proxy and the debug publication. Prefer edge as its gateway.
    await restartApp()
    const debugUrl = `http://${proxy('port', 'app', '8080')}`
    checkHeaders('/api/v1/health', 200, debugUrl)
    checkHeaders('/api/v1/missing', 404, debugUrl)
    assert.equal(request('/api/v1/session', owner, undefined, debugUrl).status, 200)
    for (let n = 1; n <= 20; n++) {
      assert.equal(request('/api/v1/session', { email: `debug${n}@example.test`, password: 'wrong-password-test-only' },
        `198.51.100.${n}`, debugUrl).status, 401)
    }
    assert.equal(request('/api/v1/session', owner, '192.0.2.199', debugUrl).status, 429)
    proxy('stop', 'app')
    const [stopped] = JSON.parse(run(['inspect', app]))
    assert.equal(stopped.State.ExitCode, 0, 'PID 1 must handle default SIGTERM without SIGKILL')
    assert.equal(stopped.State.OOMKilled, false)
    // Upstream error-path coverage only: refused peers do not measure the 5s
    // connect limit. The static config guard verifies that timeout in both profiles.
    checkHeaders('/api/v1/health', [502, 504])
    checkCacheAndCompression('/api/v1/health')
    await restartApp()
    assert.equal(request('/api/v1/setup').body, '{"setup_required":false}')
    const history = authenticated(messagesPath)
    assert.equal(history.status, 200)
    assert.equal(JSON.parse(history.body).messages[0].body, 'Fresh read-only send')
    assert.equal(authenticated(messagesPath, { body: 'Read-only send after restart', client_message_id: randomUUID() }).status, 201)
    assert.equal(run(['diff', app]), '')
    console.log(`PASS ${profile}: read-only app/migrate, healthy HTTPS probe, sends/restart/history, browser headers on success/app/proxy errors, HSTS/redirect, compression/cache, non-root, log rotation, SIGTERM exit 0, setup token, forwarded-IP spoofing denials, independent client budgets`)
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
  if (lifecycle) ca = buildRenewalPebble(directory, run)
  for (const profile of process.env.CHECK_COMPOSE_PROFILE ? [process.env.CHECK_COMPOSE_PROFILE] : ['caddy', 'nginx']) {
    assert.ok(['caddy', 'nginx'].includes(profile))
    await check(profile)
  }
} finally {
  if (!process.env.CHECK_COMPOSE_IMAGE) run(['image', 'rm', image])
  rmSync(directory, { recursive: true, force: true })
}
