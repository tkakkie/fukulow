import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const env = { PATH: process.env.PATH, POSTGRES_PASSWORD: 'compose-config-test-only', POSTGRES_APP_PASSWORD: 'app-config-test-only', FUKULOW_SETUP_TOKEN: 'setup-config-test-only' }
const args = (profile: string) => ['compose', '--env-file', '/dev/null', '-f', 'compose.yml', '--profile', profile, 'config', '--format', 'json']
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
const approvedProxyConfig = {
  caddy: `(browser_headers) {
	header >Permissions-Policy "${permissionsPolicy}"
	header >Cross-Origin-Opener-Policy "same-origin"
}

{$FUKULOW_DOMAIN:localhost} {
	import browser_headers
	@static not path /api /api/*
	encode @static zstd gzip
	@hsts {
		protocol https
		not host localhost 127.0.0.1 [::1]
	}
	header @hsts Strict-Transport-Security "max-age=31536000"
	respond /api/v1/ready 404
	reverse_proxy app:8080 {
		flush_interval -1
	}
	handle_errors {
		import browser_headers
		respond "{err.status_code} {err.status_text}" {err.status_code}
	}
}`,
  nginx: `map $http_upgrade $connection_upgrade { default upgrade; '' close; }
map $https $hsts { default ""; on "max-age=31536000"; }
server {
    listen 80;
    add_header Strict-Transport-Security $hsts always;
    proxy_hide_header Permissions-Policy;
    proxy_hide_header Cross-Origin-Opener-Policy;
    add_header Permissions-Policy "${permissionsPolicy}" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    gzip on;
    gzip_vary on;
    gzip_types text/css text/javascript application/javascript image/svg+xml;
    gzip_proxied any;
    location = /api/v1/ready {
        return 404;
    }
    location / {
        proxy_pass http://app:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}`
}

function proxyTokens(profile: string, source: string): string[] {
  assert.doesNotMatch(source, /[^\x09\x0a\x0d\x20-\x7e]/, 'unsupported proxy character')
  const tokens: string[] = []
  // Backslash escapes, backticks, arbitrary placeholders and non-ASCII whitespace
  // are unsupported: never silently reinterpret syntax the proxy may treat differently.
  const token = /[ \t\r]+|\n|#[^\r\n]*|\{\$FUKULOW_DOMAIN:localhost\}|\{err.status_code\}|"[^"\\\r\n]*"|'[^'\\\r\n]*'|[{};]|[^\s{};"'\\#`]+/gy
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
  const bases = dockerfile.matchAll(/^FROM (\S+)/gm)
  for (const [, image] of bases) assert.match(image, /^\w+:[\w.-]+@sha256:[a-f0-9]{64}$/, 'base image must pin tag and digest')
}

function checkImagesAndLogs(services: Record<string, { build?: unknown, image: string, logging: unknown }>) {
  const builtImages = new Set(Object.values(services).filter(service => service.build).map(service => service.image))
  for (const [name, service] of Object.entries(services)) {
    if (!builtImages.has(service.image)) assert.match(service.image, /^[\w/.-]+:[\w.-]+@sha256:[a-f0-9]{64}$/, `${name} must pin tag and digest`)
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
    }
  }
})

test('base image check rejects an unpinned Dockerfile base', () => {
  assert.throws(() => checkBaseImages('FROM debian:bookworm-slim\n'), /base image must pin tag and digest/)
})

test('upgrade rehearsal pins both old images for the post-merge Compose shape', () => {
  // HEAD is available even in CI's shallow checkout and has the post-merge shape.
  const output = execFileSync(process.execPath, ['scripts/check-db-upgrade.ts', '--check-config'],
    { cwd, env: { PATH: process.env.PATH, CHECK_UPGRADE_REVISION: 'HEAD' }, encoding: 'utf8' })
  assert.match(output, /PASS old stack images: app=.+ migrate=true/)
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
      { cwd, env: { PATH: process.env.PATH, POSTGRES_APP_PASSWORD: env.POSTGRES_APP_PASSWORD }, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FUKULOW_SETUP_TOKEN/)
  }
})

test('both profiles require an app password and keep owner credentials outside app', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const password of [undefined, '']) {
      const result = spawnSync('docker', args(profile), { cwd, env: { ...env, POSTGRES_APP_PASSWORD: password }, encoding: 'utf8' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /POSTGRES_APP_PASSWORD/)
    }
    const { services: { app, migrate } } = JSON.parse(execFileSync('docker', args(profile), { cwd, env, encoding: 'utf8' }))
    assert.equal(app.environment.DATABASE_URL, `postgres://fukulow_app:${env.POSTGRES_APP_PASSWORD}@db:5432/fukulow`)
    assert.ok(!Object.values(app.environment).some(value => String(value).includes(env.POSTGRES_PASSWORD)))
    assert.equal(app.environment.POSTGRES_APP_PASSWORD, undefined)
    assert.equal(app.environment.POSTGRES_PASSWORD, undefined)
    assert.equal(app.depends_on.migrate.condition, 'service_completed_successfully')
    assert.deepEqual(Object.keys(migrate.networks), ['backend'])
    assert.equal(migrate.environment.DATABASE_URL, `postgres://fukulow:${env.POSTGRES_PASSWORD}@db:5432/fukulow`)
    assert.deepEqual(migrate.entrypoint, ['fukulow-server', 'migrate'])
    assert.deepEqual(migrate.command, [])
    assert.equal(migrate.restart, 'no')
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

test('app pool settings forward defaults, overrides and invalid empty values only to app', () => {
  for (const profile of ['caddy', 'nginx']) {
    for (const overrides of [{}, { FUKULOW_DB_MAX_CONNECTIONS: '3', FUKULOW_DB_ACQUIRE_TIMEOUT_MS: '250' },
      { FUKULOW_DB_MAX_CONNECTIONS: '', FUKULOW_DB_ACQUIRE_TIMEOUT_MS: '' }]) {
      const config = JSON.parse(execFileSync('docker', args(profile),
        { cwd, env: { ...env, ...overrides }, encoding: 'utf8' }))
      for (const [name, fallback] of [['FUKULOW_DB_MAX_CONNECTIONS', '20'], ['FUKULOW_DB_ACQUIRE_TIMEOUT_MS', '1000']]) {
        assert.equal(config.services.app.environment[name], overrides[name as keyof typeof overrides] ?? fallback)
        assert.equal(config.services.migrate.environment[name], undefined)
      }
    }
  }
})
