import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const env = { PATH: process.env.PATH, COMPOSE_PROJECT_NAME: `fukulow-config-${process.pid}`,
  POSTGRES_PASSWORD: 'compose-config-test-only', POSTGRES_APP_PASSWORD: 'app-config-test-only', FUKULOW_SETUP_TOKEN: 'setup-config-test-only', FUKULOW_VERSION: '1.2.3' }
const args = (profile: string, external = false) => ['compose', '--env-file', '/dev/null', '-f', 'compose.yml',
  ...(external ? ['-f', 'compose.external-db.yml'] : []), '--profile', profile, 'config', '--format', 'json']
const permissionsPolicy = 'accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()'

function checkRestrictions(service: Record<string, unknown>) {
  assert.equal(service.read_only, true, 'read_only must be true')
  assert.deepEqual(service.cap_drop, ['ALL'], 'cap_drop must deny ALL')
  assert.deepEqual(service.security_opt, ['no-new-privileges:true'], 'no-new-privileges must be true')
  assert.ok(!service.privileged, 'privileged must be disabled')
  assert.deepEqual(service.cap_add ?? [], [], 'cap_add must stay empty')
  assert.deepEqual(service.volumes ?? [], [], 'no demonstrated writable-path exception')
  assert.deepEqual(service.tmpfs ?? [], [], 'no demonstrated tmpfs exception')
}

// This is a restricted grammar, not a general proxy-config interpreter. Compare
// every token (including scope/delimiters) with the approved deployment shape so
// new includes, routes, inheritance controls and header operations require review.
// Keep values/quoting exact; HTTP field names alone are case-insensitive.
const approvedProxyConfig: Record<string, string> = {
  caddy: `{
	servers {
		strict_sni_host on
	}
}

(browser_headers) {
	header >Permissions-Policy "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()"
	header >Cross-Origin-Opener-Policy "same-origin"
}

:80 {
	abort
}

http://{$FUKULOW_DOMAIN:localhost} {
	import browser_headers
	route {
		respond /.well-known/acme-challenge/* 404
		redir https://{$FUKULOW_DOMAIN:localhost}{uri} 308
	}
}

{$FUKULOW_DOMAIN:localhost} {
	import browser_headers
	@api path /api /api/*
	header @api >Cache-Control "no-store"
	# The app negotiates precompressed Brotli; preserve identity responses too.
	@hsts {
		protocol https
		not host localhost 127.0.0.1 [::1]
	}
	header @hsts Strict-Transport-Security "max-age=31536000"
	respond /api/v1/ready 404
	reverse_proxy app:8080 {
		flush_interval -1
		transport http {
			dial_timeout 5s
			read_timeout 3600s
			write_timeout 3600s
		}
	}
	# Upstream connection errors execute a separate route chain.
	handle_errors {
		import browser_headers
		header @api >Cache-Control "no-store"
		respond "{err.status_code} {err.status_text}" {err.status_code}
	}
}
`,
  nginx: `load_module /usr/lib/nginx/modules/ngx_http_acme_module.so;
worker_processes auto;
error_log stderr warn;
pid /tmp/nginx.pid;
events { worker_connections 4096; }
http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    # Do not log request paths, headers, ACME challenges or credentials.
    access_log off;
    resolver 127.0.0.11 ipv6=off;
    acme_issuer public {
        uri https://acme-v02.api.letsencrypt.org/directory;
        challenge http-01;
        state_path /var/lib/nginx/acme;
        accept_terms_of_service;
    }
    map $http_upgrade $connection_upgrade { default upgrade; '' close; }
    # Validate the raw Host too: absolute-form targets can override $host.
    map $http_host $request_host { default $http_host; ~^([^:]+):[0-9]+$ $1; }
    map $request_host $known_host { default 0; \${FUKULOW_DOMAIN} 1; }
    map $https $hsts { default ""; on "max-age=31536000"; }
    map $uri $response_cache_control { default $upstream_http_cache_control; ~^/api(?:/|$) "no-store"; }
    add_header Strict-Transport-Security $hsts always;
    proxy_hide_header Cache-Control;
    add_header Cache-Control $response_cache_control always;
    # Child servers/locations must inherit these headers without overrides.
    proxy_hide_header Permissions-Policy;
    proxy_hide_header Cross-Origin-Opener-Policy;
    add_header Permissions-Policy "accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_connect_timeout 5s;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    server {
        listen 80 default_server;
        listen 443 ssl default_server;
        ssl_reject_handshake on;
        return 444;
    }
    server {
        listen 80;
        server_name \${FUKULOW_DOMAIN};
        if ($known_host = 0) { return 444; }
        # nginx-acme 0.4.1 src/acme/solvers/http.rs registers POST_READ,
        # before location lookup/rewrite: active tokens bypass this fallback.
        # https://nginx.org/en/docs/http/ngx_http_acme_module.html (404 example)
        location ^~ /.well-known/acme-challenge/ { return 404; }
        location / { return 308 https://\${FUKULOW_DOMAIN}$request_uri; }
    }
    server {
        listen 443 ssl;
        server_name \${FUKULOW_DOMAIN};
        if ($known_host = 0) { return 444; }
        acme_certificate public;
        ssl_certificate $acme_certificate;
        ssl_certificate_key $acme_certificate_key;
        # Keep the serving cache shorter than the CI certificate lifetime too.
        ssl_certificate_cache max=2 valid=1s;
        # The app negotiates precompressed Brotli; preserve identity responses too.
        gzip off;
        location = /api { gzip off; proxy_pass http://app:8080; }
        location /api/ { gzip off; proxy_pass http://app:8080; }
        location = /api/v1/ready {
            gzip off;
            return 404;
        }
        location / {
            proxy_pass http://app:8080;
        }
    }
}
`
}

function proxyTokens(profile: string, source: string): string[] {
  assert.doesNotMatch(source, /[^\x09\x0a\x0d\x20-\x7e]/, 'unsupported proxy character')
  const tokens: string[] = []
  // Backslash escapes, backticks, arbitrary placeholders and non-ASCII whitespace
  // are unsupported: never silently reinterpret syntax the proxy may treat differently.
  const token = /https:\/\/(?:\{host\}|\{\$FUKULOW_DOMAIN:localhost\})\{uri\}|https:\/\/\$\{FUKULOW_DOMAIN\}\$request_uri|(?:http:\/\/)?\{\$FUKULOW_DOMAIN:localhost\}|\$\{FUKULOW_DOMAIN\}|\{host\}\{uri\}|[ \t\r]+|\n|#[^\r\n]*|\{\$FUKULOW_DOMAIN:localhost\}|\{err.status_code\}|"[^"\\\r\n]*"|'[^'\\\r\n]*'|[{};]|[^\s{};"'\\#`]+/gy
  let position = 0
  let separated = true
  let previous = ''
  while (position < source.length) {
    token.lastIndex = position
    const match = token.exec(source)
    assert.ok(match, 'unsupported proxy syntax')
    const value = match[0]
    position = token.lastIndex
    if (value.startsWith('#')) assert.ok(separated, 'unsupported proxy comment adjacency')
    if (/^[ \t\r]+$/.test(value) || value.startsWith('#')) {
      separated = true
      continue
    }
    if (value === '\n') {
      separated = true
      // Caddy statements end at newlines; nginx statements end at semicolons.
      if (profile === 'caddy' && tokens.length && tokens.at(-1) !== '\n') tokens.push(value)
      continue
    }
    // Adjacent quoted/bare words can concatenate in the real parsers; they are
    // not equivalent to separate arguments. Block openers also require spacing.
    assert.ok(separated || /^[};]$/.test(value) || /^[{};]$/.test(previous), 'unsupported proxy token adjacency')
    tokens.push(/^(>?)(permissions-policy|cross-origin-opener-policy)$/i.test(value) ? value.toLowerCase() : value)
    previous = value
    separated = false
  }
  if (tokens.at(-1) === '\n') tokens.pop()
  return tokens
}

function checkProxyHeaders(profile: string, source: string) {
  assert.ok(profile === 'caddy' || profile === 'nginx', 'unsupported proxy profile')
  const approved = approvedProxyConfig[profile]
  assert.deepEqual(proxyTokens(profile, source), proxyTokens(profile, approved),
    'unsupported proxy configuration: preserve the approved headers, inheritance and route scopes')
}

test('deployment and load app and migrate enforce container restrictions with removal and weakening denials', () => {
  for (const file of ['compose.yml', 'load/compose.yml']) {
    for (const profileArgs of file === 'compose.yml' ? [['--profile', 'caddy'], ['--profile', 'nginx']] : [[]]) {
      const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', file,
        ...profileArgs, 'config', '--format', 'json'], { cwd, env: { ...env, LOAD_PROJECT: 'restrictions-test', LOAD_PORT: '18080',
          LOAD_DB_PASSWORD: 'owner-test-only', LOAD_APP_PASSWORD: 'app-test-only', LOAD_SETUP_TOKEN: 'setup-test-only' }, encoding: 'utf8' }))
      for (const name of ['app', 'migrate']) {
        const service = config.services[name]
        checkRestrictions(service)
        for (const [key, weakened] of [['read_only', false], ['cap_drop', ['NET_RAW']], ['security_opt', ['no-new-privileges:false']]] as const) {
          const removed = structuredClone(service)
          delete removed[key]
          assert.throws(() => checkRestrictions(removed), undefined, `${file} ${name} removed ${key}`)
          assert.throws(() => checkRestrictions({ ...service, [key]: weakened }), undefined, `${file} ${name} weakened ${key}`)
        }
        for (const mutation of [{ privileged: true }, { cap_add: ['NET_RAW'] }, { volumes: ['/tmp:/tmp'] }, { tmpfs: ['/tmp'] }]) {
          assert.throws(() => checkRestrictions({ ...service, ...mutation }))
        }
      }
    }
  }
})

test('both proxies enforce browser headers with removal weakening and inheritance denials', () => {
  for (const [profile, file] of [['caddy', 'deploy/Caddyfile'], ['nginx', 'deploy/nginx.conf']]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    checkProxyHeaders(profile, source)
    for (const name of ['Permissions-Policy', 'Cross-Origin-Opener-Policy']) {
      const declaration = source.split('\n').find(line => line.includes(name) && !line.includes('proxy_hide_header'))!
      assert.throws(() => checkProxyHeaders(profile, source.replace(declaration, '')), undefined, `${profile} removed ${name}`)
      const weakened = name === 'Permissions-Policy' ? declaration.replace('camera=()', 'camera=(self)') : declaration.replace('same-origin', 'unsafe-none')
      assert.throws(() => checkProxyHeaders(profile, source.replace(declaration, weakened)), undefined, `${profile} weakened ${name}`)
      if (profile === 'nginx') {
        assert.throws(() => checkProxyHeaders(profile, source.replace(declaration, declaration.replace(' always;', ';'))))
        assert.throws(() => checkProxyHeaders(profile, source.replace(`    proxy_hide_header ${name};`, '')))
      } else {
        assert.throws(() => checkProxyHeaders(profile, source.replace(declaration, declaration.replace('header >', 'header @hsts >'))))
        assert.throws(() => checkProxyHeaders(profile, source.replace(declaration, declaration.replace('header >', 'header '))))
      }
    }
    if (profile === 'nginx') {
      assert.throws(() => checkProxyHeaders(profile, source.replace('return 404;', 'add_header X-Test "test";\n        return 404;')))
    } else {
      for (const declaration of ['\timport browser_headers\n', '\t\timport browser_headers\n']) {
        assert.throws(() => checkProxyHeaders(profile, source.replace(declaration, '')))
      }
    }
  }
  const app = readFileSync(new URL('../server/src/lib.rs', import.meta.url), 'utf8')
  assert.ok(app.includes(`const PERMISSIONS_POLICY: &str = "${permissionsPolicy}";`), 'direct app policy must agree with proxies')
})

test('proxy grammar rejects unprobed scopes, inheritance controls and alternate header syntax', () => {
  const nginx = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8')
  const caddy = readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8')
  const deny = (profile: string, source: string, label: string) =>
    assert.throws(() => checkProxyHeaders(profile, source), /unsupported proxy/, label)
  for (const whitespace of [' ', '\t', '  \t ', '\n', '\r\n', '\v', '\f', '\u2003']) {
    for (const directive of ['add_header Cache-Control "public";', 'add_header_inherit off;']) {
      const statement = directive.replace(' ', whitespace)
      deny('nginx', nginx.replace('    location / {', `    location /assets/ { ${statement} return 404; }\n    location / {`),
        `unprobed inline location: ${JSON.stringify(whitespace)} ${directive}`)
      deny('nginx', nginx.replace('return 404;', `${statement}\n        return 404;`),
        `existing location: ${JSON.stringify(whitespace)} ${directive}`)
    }
  }
  for (const directive of ['add_header Cache-Control "public";', 'add_header_inherit off;']) {
    deny('nginx', nginx.replace('    location / {', `    location /assets/ {\n        ${directive}\n        return 404;\n    }\n    location / {`),
      `unprobed multiline location: ${directive}`)
  }
  for (const block of ['location /assets/', 'if ($request_method = GET)', 'limit_except GET']) {
    for (const directive of ['add_header X-Test test;', 'add_header_inherit off;', 'add_header_inherit merge;']) {
      for (const body of [`${block} { ${directive} }`, `${block} {\n ${directive}\n }`]) {
        deny('nginx', nginx.replace('return 404;', `${body}\n return 404;`), `${block}: ${directive}`)
      }
    }
  }
  for (const level of ['server {', 'location / {']) {
    for (const value of ['off', 'on', 'merge']) {
      deny('nginx', nginx.replace(level, `${level}\n add_header_inherit ${value};`), `${level} inheritance ${value}`)
    }
  }
  for (const [name, value] of [['Cross-Origin-Opener-Policy', 'same-origin'], ['Permissions-Policy', permissionsPolicy]]) {
    for (const spelling of [name, name.toLowerCase(), name.toUpperCase()]) {
      for (const added of [value, 'unsafe-none']) {
        deny('nginx', nginx.replace('server {', `server {\n add_header ${spelling} "${added}" always;`), `duplicate/conflicting nginx ${spelling}`)
        for (const operation of ['>', '', '+', '-', '?']) {
          deny('caddy', caddy.replace('(browser_headers) {', `(browser_headers) {\n header ${operation}${spelling} "${added}"`),
            `duplicate/conflicting Caddy ${operation}${spelling}`)
        }
      }
    }
    // A single field with alternate capitalization still has the same meaning.
    checkProxyHeaders('nginx', nginx.replaceAll(name, name.toLowerCase()))
    checkProxyHeaders('caddy', caddy.replaceAll(name, name.toLowerCase()))
  }
  for (const added of [
    'header {\n cross-origin-opener-policy unsafe-none\n}',
    'header { cross-origin-opener-policy unsafe-none }',
    'header /assets/* cross-origin-opener-policy unsafe-none',
    'route /assets/* {\n header -permissions-policy\n}',
    'import /tmp/unchecked-headers',
  ]) deny('caddy', caddy.replace('\timport browser_headers', `\timport browser_headers\n${added}`), added)
  for (const added of ['include /tmp/unchecked-headers;', 'more_clear_headers Permissions-Policy;', 'add_header "cross-origin-opener-policy" unsafe-none always;']) {
    deny('nginx', nginx.replace('server {', `server {\n ${added}`), added)
  }
  deny('nginx', nginx.replace('add_header Permissions-Policy', 'add_header\\\n Permissions-Policy'), 'unsupported escape')
  deny('caddy', caddy.replace('header >Permissions-Policy', 'header `>Permissions-Policy`'), 'unsupported quoting')
  deny('nginx', nginx.replace('"same-origin" always', '"same-origin"always'), 'unsupported concatenated arguments')
  deny('nginx', nginx.replace('server {', 'server{'), 'unsupported block adjacency')
  deny('caddy', caddy.replace('import browser_headers', 'import browser_headers#unchecked'), 'unsupported comment adjacency')
  // Harmless nginx formatting (including multiline statements/inline blocks) and
  // ordinary Caddy indentation/comments do not change the accepted token stream.
  const uncommented = nginx.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')
  checkProxyHeaders('nginx', uncommented.replace(/add_header /g, 'add_header\t\n').replaceAll('\n', '\r\n'))
  checkProxyHeaders('nginx', nginx.split('\n').filter(line => !line.trim().startsWith('#')).map(line => line.trim()).join(' '))
  checkProxyHeaders('caddy', caddy.replaceAll('\t', '  ').replaceAll('\n', '\r\n'))
})

function checkBaseImages(dockerfile: string) {
  const stages = new Set<string>()
  for (const [, image, stage] of dockerfile.matchAll(/^FROM (\S+)(?: AS (\S+))?$/gmi)) {
    if (!stages.has(image.toLowerCase())) assert.match(image, /^\w+:[\w.-]+@sha256:[a-f0-9]{64}$/, 'base image must pin tag and digest')
    if (stage) stages.add(stage.toLowerCase())
  }
}

// The release image is selected by the operator's FUKULOW_VERSION (an immutable SemVer tag,
// optionally with the digest from its release notes); every other external image pins tag and digest.
const releaseImage = /^ghcr\.io\/tkakkie\/fukulow:\d+\.\d+\.\d+(?:-[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/
function checkImagesAndLogs(services: Record<string, { build?: unknown, image: string, logging: unknown }>) {
  const builtImages = new Set(Object.values(services).filter(service => service.build).map(service => service.image))
  for (const [name, service] of Object.entries(services)) {
    const release = ['app', 'migrate'].includes(name) && releaseImage.test(service.image)
    if (!builtImages.has(service.image) && !release) assert.match(service.image, /^[\w/.-]+:[\w.-]+@sha256:[a-f0-9]{64}$/, `${name} must pin tag and digest`)
    assert.deepEqual(service.logging, { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } }, `${name} must rotate logs`)
  }
}

test('all base images and external Compose images are pinned; every deployment/load service rotates logs', () => {
  checkBaseImages(readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8'))
  const loadEnv = { ...env, LOAD_PROJECT: 'config-test-only', LOAD_PORT: '18080',
    LOAD_DB_PASSWORD: 'load-db-test-only', LOAD_APP_PASSWORD: 'load-app-test-only', LOAD_SETUP_TOKEN: 'load-setup-test-only' }
  for (const file of ['compose.yml', 'load/compose.yml']) {
    for (const profileArgs of file === 'compose.yml' ? [['--profile', 'caddy'], ['--profile', 'nginx']] : [[]]) {
      const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', file,
        ...profileArgs, 'config', '--format', 'json'], { cwd, env: loadEnv, encoding: 'utf8' }))
      checkImagesAndLogs(config.services)
      for (const mutation of ['pin', 'rotation']) {
        const broken = structuredClone(config.services)
        if (mutation === 'pin') broken.db.image = broken.db.image.split('@')[0]
        else delete broken.db.logging.options['max-file']
        assert.throws(() => checkImagesAndLogs(broken), mutation === 'pin' ? /must pin/ : /must rotate/)
      }
      if (file === 'compose.yml') {
        // Only app and migrate may use the release image, and only with a SemVer tag.
        for (const [name, image] of [['app', 'ghcr.io/tkakkie/fukulow:latest'], ['app', 'ghcr.io/tkakkie/fukulow'],
          ['app', 'ghcr.io/other/fukulow:1.2.3'], ['db', 'ghcr.io/tkakkie/fukulow:1.2.3']]) {
          const broken = structuredClone(config.services)
          broken[name].image = image
          assert.throws(() => checkImagesAndLogs(broken), /must pin/, `${name} ${image}`)
        }
      }
    }
  }
})

test('base image check rejects an unpinned Dockerfile base', () => {
  for (const source of ['FROM debian:bookworm-slim\n', 'FROM missing AS server',
    'FROM base AS server\nFROM debian:bookworm-slim AS base',
    'FROM debian:bookworm-slim AS base\nFROM base AS server']) {
    assert.throws(() => checkBaseImages(source), /base image must pin tag and digest/)
  }
  checkBaseImages('FROM rust:1.99.1-slim@sha256:' + 'a'.repeat(64) + ' AS base\nFROM base AS wasm\nFROM wasm AS server')
})

test('upgrade rehearsal pins both old images for the post-merge Compose shape', () => {
  // HEAD is available even in CI's shallow checkout and has the post-merge shape.
  const output = execFileSync(process.execPath, ['scripts/check-db-upgrade.ts', '--check-config'],
    { cwd, env: { PATH: process.env.PATH, CHECK_UPGRADE_REVISION: 'HEAD' }, encoding: 'utf8' })
  assert.match(output, /PASS old stack images: app=.+ migrate=true/)
})

test('deployment Compose runs the required FUKULOW_VERSION release and builds from source only through compose.dev.yml', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const version of [undefined, '']) {
      const result = spawnSync('docker', args(profile), { cwd, env: { ...env, FUKULOW_VERSION: version }, encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /FUKULOW_VERSION/)
    }
    const release = JSON.parse(execFileSync('docker', args(profile), { cwd, env, encoding: 'utf8' })).services
    for (const name of ['app', 'migrate']) assert.equal(release[name].image, 'ghcr.io/tkakkie/fukulow:1.2.3', name)
    for (const [name, service] of Object.entries(release)) assert.equal((service as { build?: unknown }).build, undefined, `${name} must not build`)
    const pinned = `1.2.3@sha256:${'a'.repeat(64)}`
    const digest = JSON.parse(execFileSync('docker', args(profile), { cwd, env: { ...env, FUKULOW_VERSION: pinned }, encoding: 'utf8' })).services
    assert.equal(digest.app.image, `ghcr.io/tkakkie/fukulow:${pinned}`)
    const devArgs = [...args(profile).slice(0, 5), '-f', 'compose.dev.yml', ...args(profile).slice(5)]
    const dev = JSON.parse(execFileSync('docker', devArgs, { cwd, env, encoding: 'utf8' })).services
    assert.equal(dev.app.build.context, cwd.replace(/\/$/, ''))
    for (const name of ['app', 'migrate']) assert.equal(dev[name].image, 'fukulow-app', name)
  }
  // The shipped example leaves the version empty, so copying it never starts an implicit release.
  const example = spawnSync('docker', ['compose', '--env-file', '.env.example', '-f', 'compose.yml', '--profile', 'caddy', 'config'],
    { cwd, env: { PATH: process.env.PATH, POSTGRES_APP_PASSWORD: env.POSTGRES_APP_PASSWORD, FUKULOW_SETUP_TOKEN: env.FUKULOW_SETUP_TOKEN }, encoding: 'utf8' })
  assert.notEqual(example.status, 0)
  assert.match(example.stderr, /FUKULOW_VERSION/)
  // The disposable load stack still builds the app from source.
  const load = JSON.parse(execFileSync('docker', ['compose', '--env-file', '/dev/null', '-f', 'load/compose.yml', 'config', '--format', 'json'],
    { cwd, env: { PATH: process.env.PATH, LOAD_PROJECT: 'release-config-test', LOAD_PORT: '18195', LOAD_DB_PASSWORD: 'owner-test-only',
      LOAD_APP_PASSWORD: 'app-test-only', LOAD_SETUP_TOKEN: 'setup-test-only' }, encoding: 'utf8' })).services
  assert.equal(load.app.build.context, cwd.replace(/\/$/, ''))
})

test('both profiles require a nonempty setup token before starting containers', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const token of [undefined, '']) {
      const result = spawnSync('docker', args(profile), { cwd, env: { ...env, FUKULOW_SETUP_TOKEN: token }, encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /FUKULOW_SETUP_TOKEN/)
    }
  }
})

test('the shipped deployment example cannot start either profile without a setup token', () => {
  for (const profile of ['caddy', 'nginx']) {
    const result = spawnSync('docker', ['compose', '--env-file', '.env.example', '-f', 'compose.yml', '--profile', profile, 'config'],
      { cwd, env: { PATH: process.env.PATH, POSTGRES_APP_PASSWORD: env.POSTGRES_APP_PASSWORD, FUKULOW_VERSION: env.FUKULOW_VERSION }, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FUKULOW_SETUP_TOKEN/)
  }
})

test('both profiles require bundled passwords and keep owner credentials outside app', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const key of ['POSTGRES_APP_PASSWORD', 'POSTGRES_PASSWORD']) {
      for (const password of [undefined, '']) {
        const result = spawnSync('docker', args(profile), { cwd, env: { ...env, [key]: password }, encoding: 'utf8' })
        assert.notEqual(result.status, 0)
        assert.ok(result.stderr.includes(key))
      }
    }
    const { services: { app, migrate } } = JSON.parse(execFileSync('docker', args(profile), { cwd, env, encoding: 'utf8' }))
    assert.equal(app.environment.DATABASE_URL, `postgres://fukulow_app:${env.POSTGRES_APP_PASSWORD}@db:5432/fukulow`)
    assert.equal(app.environment.FUKULOW_SEARCH_ENGINE, 'disabled')
    assert.ok(!Object.values(app.environment).some(value => String(value).includes(env.POSTGRES_PASSWORD)))
    assert.equal(app.environment.POSTGRES_APP_PASSWORD, undefined)
    assert.equal(app.environment.POSTGRES_PASSWORD, undefined)
    assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
    assert.deepEqual(Object.keys(migrate.networks), ['backend'])
    assert.equal(migrate.environment.DATABASE_URL, `postgres://fukulow:${env.POSTGRES_PASSWORD}@db:5432/fukulow`)
    assert.equal(migrate.depends_on.db.condition, 'service_healthy')
    assert.deepEqual(migrate.entrypoint, ['fukulow-server', 'migrate'])
    assert.deepEqual(migrate.command, [])
    assert.equal(migrate.restart, 'no')
  }
})

test('leftover external database URLs block bundled startup for either proxy', () => {
  const checkHealth = (db: { healthcheck: { test: string[] } }) => {
    const [mode, command] = db.healthcheck.test
    assert.equal(mode, 'CMD-SHELL')
    return spawnSync('/bin/sh', ['-c', `pg_isready() { return 0; }; ${command}`], { encoding: 'utf8' })
  }
  const leftoverUrl = 'postgres://user:leftover-db-test-only@postgres.example.test/chat'
  for (const profile of ['caddy', 'nginx']) {
    const bundled = JSON.parse(execFileSync('docker', args(profile), { cwd, env, encoding: 'utf8' }))
    assert.equal(checkHealth(bundled.services.db).status, 0)
    for (const [urlKey, passwordKey] of [
      ['FUKULOW_APP_DATABASE_URL', 'POSTGRES_APP_PASSWORD'],
      ['FUKULOW_MIGRATE_DATABASE_URL', 'POSTGRES_PASSWORD'],
    ] as const) {
      for (const password of [env[passwordKey], undefined, '']) {
        const result = spawnSync('docker', args(profile), {
          cwd, env: { ...env, [urlKey]: leftoverUrl, [passwordKey]: password }, encoding: 'utf8',
        })
        if (result.status !== 0) {
          assert.match(result.stderr, new RegExp(`${urlKey}|${passwordKey}`))
          continue
        }
        const { app, db, migrate } = JSON.parse(result.stdout).services
        assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
        assert.equal(migrate.depends_on.db.condition, 'service_healthy')
        assert.ok(!JSON.stringify(db).includes('leftover-db-test-only'))
        const health = checkHealth(db)
        assert.equal(health.status, 1)
        assert.match(health.stderr, new RegExp(urlKey))
      }
    }
  }
})

test('external PostgreSQL removes bundled resources and requires separate URLs for either proxy', () => {
  const externalEnv = {
    PATH: env.PATH, COMPOSE_PROJECT_NAME: env.COMPOSE_PROJECT_NAME, FUKULOW_SETUP_TOKEN: env.FUKULOW_SETUP_TOKEN, FUKULOW_VERSION: env.FUKULOW_VERSION,
    FUKULOW_APP_DATABASE_URL: 'postgres://fukulow_app:external-app-test-only@postgres.example.test:1532/chat?sslmode=verify-full',
    FUKULOW_MIGRATE_DATABASE_URL: 'postgres://owner:external-owner-test-only@postgres.example.test:1532/chat?sslmode=verify-full',
  }
  for (const profile of ['caddy', 'nginx']) {
    const { services, volumes } = JSON.parse(execFileSync('docker', args(profile, true), { cwd, env: externalEnv, encoding: 'utf8' }))
    assert.deepEqual(Object.keys(services).sort(), ['app', 'migrate', profile].sort())
    assert.equal(volumes.postgres_data, undefined)
    const { app, migrate } = services
    assert.equal(app.environment.DATABASE_URL, externalEnv.FUKULOW_APP_DATABASE_URL)
    assert.equal(app.environment.FUKULOW_SEARCH_ENGINE, 'disabled')
    assert.equal(migrate.environment.DATABASE_URL, externalEnv.FUKULOW_MIGRATE_DATABASE_URL)
    assert.equal(migrate.depends_on, undefined)
    assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
    for (const [service, forbidden] of [[app, 'external-owner-test-only'], [migrate, 'external-app-test-only']] as const) {
      assert.ok(!Object.values(service.environment).some(value => String(value).includes(forbidden)))
      assert.equal(service.environment.POSTGRES_PASSWORD, undefined)
      assert.equal(service.environment.POSTGRES_APP_PASSWORD, undefined)
      assert.equal(service.environment.PGSSLMODE, 'verify-full')
      assert.equal(service.ports, undefined)
      checkRestrictions(service)
    }
    for (const key of ['FUKULOW_APP_DATABASE_URL', 'FUKULOW_MIGRATE_DATABASE_URL']) {
      for (const url of [undefined, '']) {
        const result = spawnSync('docker', args(profile, true), { cwd, env: { ...env, ...externalEnv, [key]: url }, encoding: 'utf8' })
        assert.notEqual(result.status, 0)
        assert.ok(result.stderr.includes(key))
      }
    }
  }
})

test('the disposable load stack also separates owner migrations from app credentials', () => {
  const loadEnv = { PATH: process.env.PATH, LOAD_PROJECT: 'roles-config-test', LOAD_PORT: '18194',
    LOAD_DB_PASSWORD: 'load-owner-config-test-only', LOAD_APP_PASSWORD: 'load-app-config-test-only',
    LOAD_SETUP_TOKEN: 'load-setup-config-test-only' }
  const loadArgs = ['compose', '--env-file', '/dev/null', '-f', 'load/compose.yml', 'config', '--format', 'json']
  const { services: { app, migrate } } = JSON.parse(execFileSync('docker', loadArgs, { cwd, env: loadEnv, encoding: 'utf8' }))
  assert.equal(app.environment.DATABASE_URL, `postgres://fukulow_app:${loadEnv.LOAD_APP_PASSWORD}@db:5432/fukulow`)
  assert.equal(migrate.environment.DATABASE_URL, `postgres://fukulow:${loadEnv.LOAD_DB_PASSWORD}@db:5432/fukulow`)
  assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
  const result = spawnSync('docker', loadArgs, { cwd, env: { ...loadEnv, LOAD_APP_PASSWORD: undefined }, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /LOAD_APP_PASSWORD/)
})

test('the send limit keeps the production default unless the environment overrides it', () => {
  const unset = JSON.parse(execFileSync('docker', args('caddy'), { cwd, env, encoding: 'utf8' })).services.app
  assert.equal(String(unset.environment.FUKULOW_SEND_BURST), '10')
  assert.equal(String(unset.environment.FUKULOW_SEND_REFILL_PER_SECOND), '1')
  const raised = JSON.parse(execFileSync('docker', args('caddy'), { cwd, env: { ...env, FUKULOW_SEND_BURST: '10000', FUKULOW_SEND_REFILL_PER_SECOND: '1000' }, encoding: 'utf8' })).services.app
  assert.equal(String(raised.environment.FUKULOW_SEND_BURST), '10000')
  assert.equal(String(raised.environment.FUKULOW_SEND_REFILL_PER_SECOND), '1000')
})

test('both profiles isolate the database and trust only the fixed proxy IP, including custom prefixes', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const prefix of ['172.30.94', '172.29.193']) {
      const config = JSON.parse(execFileSync('docker', args(profile), { cwd, env: { ...env, FUKULOW_EDGE_PREFIX: prefix }, encoding: 'utf8' }))
      const { app, db } = config.services
      assert.equal(app.ports, undefined)
      assert.deepEqual(Object.keys(app.networks).sort(), ['backend', 'edge'])
      assert.equal(app.networks.edge.ipv4_address, `${prefix}.3`)
      assert.deepEqual(Object.keys(db.networks), ['backend'])
      assert.equal(db.ports, undefined)
      assert.deepEqual(Object.keys(config.services[profile].networks), ['edge'])
      assert.equal(config.services[profile].networks.edge.ipv4_address, `${prefix}.2`)
      assert.equal(app.environment.FUKULOW_TRUSTED_PROXIES, `${prefix}.2`)
      assert.equal(app.environment.FUKULOW_CLIENT_IP_HEADER, 'x-forwarded-for')
      assert.deepEqual(config.networks.edge.ipam.config, [{ subnet: `${prefix}.0/29`, gateway: `${prefix}.1`, ip_range: `${prefix}.4/30` }])
    }
  }
})

function checkNginxTLS(service: any) {
  assert.deepEqual(service.ports.map((port: any) => port.target).sort((a: number, b: number) => a - b), [80, 443])
  assert.equal(service.environment.FUKULOW_DOMAIN, 'localhost')
  assert.deepEqual(service.entrypoint, ['/bin/bash', '/etc/nginx/acme-entrypoint.sh'])
  assert.ok(service.volumes.some((volume: any) => volume.type === 'volume' && volume.target === '/var/lib/nginx/acme'))
  assert.ok(service.volumes.some((volume: any) => volume.read_only && volume.target === '/etc/nginx/templates/nginx.conf.template'))
  assert.ok(service.volumes.some((volume: any) => volume.read_only && volume.target === '/etc/nginx/acme-entrypoint.sh'))
}

test('nginx TLS requires the full config, private state volume and package ABI check', () => {
  const service = JSON.parse(execFileSync('docker', args('nginx'), { cwd, env, encoding: 'utf8' })).services.nginx
  checkNginxTLS(service)
  for (const key of ['ports', 'volumes', 'entrypoint']) {
    assert.throws(() => checkNginxTLS({ ...service, [key]: [] }))
  }
  assert.throws(() => checkNginxTLS({ ...service, environment: {} }))
  const entrypoint = readFileSync(new URL('../deploy/nginx-acme.sh', import.meta.url), 'utf8')
  for (const required of ['nginx-module-acme', '$NGINX_ACME_PACKAGE_VERSION', '-o nginx -g nginx -m 700 /var/lib/nginx/acme',
    'ip_unprivileged_port_start', '> 80', 'umask 077', '--reuid=nginx --regid=nginx --init-groups nginx -t', 'exec setpriv']) {
    assert.ok(entrypoint.includes(required), required)
  }
})

test('nginx startup clearly rejects a network namespace that disables unprivileged port binding', () => {
  const service = JSON.parse(execFileSync('docker', args('nginx'), { cwd, env, encoding: 'utf8' })).services.nginx
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024',
    '--mount', `type=bind,source=${cwd}/deploy/nginx-acme.sh,target=/entrypoint.sh,readonly`,
    '--entrypoint', '/bin/bash', service.image, '/entrypoint.sh'], { cwd, env, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /nginx requires net.ipv4.ip_unprivileged_port_start <= 80 in its container network namespace/)
})

test('both proxy configs reject unknown Hosts and SNI and redirect only to configured domain', () => {
  for (const [profile, config] of Object.entries(approvedProxyConfig)) {
    const fragments = profile === 'nginx'
      ? ['listen 80 default_server;', 'listen 443 ssl default_server;', 'ssl_reject_handshake on;', 'return 444;',
        'map $http_host $request_host', 'map $request_host $known_host', 'if ($known_host = 0) { return 444; }',
        'return 308 https://${FUKULOW_DOMAIN}$request_uri;']
      : ['strict_sni_host on', ':80 {\n\tabort\n}', 'redir https://{$FUKULOW_DOMAIN:localhost}{uri} 308']
    for (const fragment of fragments) {
      assert.ok(config.includes(fragment), fragment)
      assert.throws(() => checkProxyHeaders(profile, config.replace(fragment, '')), /unsupported proxy/)
    }
    const reflected = profile === 'nginx'
      ? config.replace('https://${FUKULOW_DOMAIN}$request_uri', 'https://$host$request_uri')
      : config.replace('https://{$FUKULOW_DOMAIN:localhost}{uri}', 'https://{host}{uri}')
    assert.throws(() => checkProxyHeaders(profile, reflected), /unsupported proxy/)
  }
})

test('both proxy configs retain HTTP-01 routing, TLS, API compression exclusions and bounded upstream timeouts', () => {
  for (const [profile, config] of Object.entries(approvedProxyConfig)) {
    const fragments = profile === 'nginx'
      ? ['load_module /usr/lib/nginx/modules/ngx_http_acme_module.so;', 'challenge http-01;', 'state_path /var/lib/nginx/acme;',
        'listen 443 ssl;', 'acme_certificate public;', 'location ^~ /.well-known/acme-challenge/', 'return 308 https://${FUKULOW_DOMAIN}$request_uri;',
        'map $uri $response_cache_control', 'proxy_hide_header Cache-Control;', 'add_header Cache-Control $response_cache_control always;',
        '# The app negotiates precompressed Brotli; preserve identity responses too.\n        gzip off;',
        'location = /api/v1/ready {\n            gzip off;',
        'location = /api { gzip off;', 'location /api/ { gzip off;', 'proxy_connect_timeout 5s;', 'proxy_read_timeout 3600s;', 'proxy_send_timeout 3600s;']
      : ['respond /.well-known/acme-challenge/* 404', 'redir https://{$FUKULOW_DOMAIN:localhost}{uri} 308',
        'header @api >Cache-Control "no-store"',
        'dial_timeout 5s', 'read_timeout 3600s', 'write_timeout 3600s']
    checkProxyHeaders(profile, config)
    for (const fragment of fragments) {
      assert.ok(config.includes(fragment), fragment)
      assert.throws(() => checkProxyHeaders(profile, config.replace(fragment, '')), /unsupported proxy/)
    }
  }
})

test('app pool settings forward defaults, overrides and invalid empty values only to app', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const overrides of [{}, { FUKULOW_DB_MAX_CONNECTIONS: '3', FUKULOW_DB_ACQUIRE_TIMEOUT_MS: '250' },
      { FUKULOW_DB_MAX_CONNECTIONS: '', FUKULOW_DB_ACQUIRE_TIMEOUT_MS: '' }]) {
      const config = JSON.parse(execFileSync('docker', args(profile),
        { cwd, env: { ...env, ...overrides }, encoding: 'utf8' }))
      for (const [name, fallback] of [['FUKULOW_DB_MAX_CONNECTIONS', '20'], ['FUKULOW_DB_ACQUIRE_TIMEOUT_MS', '5000']]) {
        assert.equal(config.services.app.environment[name], overrides[name as keyof typeof overrides] ?? fallback)
        assert.equal(config.services.migrate.environment[name], undefined)
      }
    }
  }
})
