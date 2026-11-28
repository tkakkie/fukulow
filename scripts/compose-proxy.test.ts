import { execFileSync, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { cwd, env, args, checkRestrictions } from './compose-test-helpers.ts'

const permissionsPolicy = 'accelerometer=(), autoplay=(), camera=(), clipboard-read=(), clipboard-write=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), hid=(), idle-detection=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), screen-wake-lock=(), serial=(), usb=(), web-share=(), xr-spatial-tracking=()'

test('none publishes only loopback by default and keeps bundled proxy trust isolated', () => {
  const file = 'compose.external-proxy.yml'
  const domain = { FUKULOW_DOMAIN: 'chat.example.com' }
  const configured = { ...domain, FUKULOW_ADDR: '127.0.0.1:8080', FUKULOW_CONTAINER_PORT: '9090',
    FUKULOW_PUBLISH_ADDR: '192.0.2.10', FUKULOW_PUBLISH_PORT: '18080',
    FUKULOW_TRUSTED_PROXIES: '192.0.2.2', FUKULOW_CLIENT_IP_HEADER: 'CF-Connecting-IP', FUKULOW_COOKIE_SECURE: 'false' }
  const render = (profile: string, files: string[], overrides: Record<string, string>) => JSON.parse(execFileSync('docker',
    ['compose', '--env-file', '/dev/null', '-f', 'compose.yml', ...files.flatMap(file => ['-f', file]),
      'config', '--format', 'json'], { cwd, env: { ...env, COMPOSE_PROFILES: profile, ...overrides }, encoding: 'utf8' })).services

  const defaults = render('none', [file], domain)
  assert.deepEqual(Object.keys(defaults).sort(), ['app', 'db', 'migrate'])
  checkRestrictions(defaults.app)
  assert.deepEqual(defaults.app.ports.map(({ host_ip, published, target }) => [host_ip, published, target]),
    [['127.0.0.1', '8080', 8080]])
  assert.equal(defaults.app.environment.FUKULOW_ADDR, '0.0.0.0:8080')
  assert.equal(defaults.app.environment.FUKULOW_ALLOWED_HOST, domain.FUKULOW_DOMAIN)
  assert.equal(defaults.app.environment.FUKULOW_COOKIE_SECURE, 'true')
  assert.equal(defaults.app.environment.FUKULOW_TRUSTED_PROXIES ?? null, null)
  assert.equal(defaults.app.environment.FUKULOW_CLIENT_IP_HEADER ?? null, null)

  const app = render('none', [file], configured).app
  assert.deepEqual(app.ports.map(({ host_ip, published, target }) => [host_ip, published, target]),
    [['192.0.2.10', '18080', 9090]])
  assert.equal(app.environment.FUKULOW_ADDR, '0.0.0.0:9090')
  assert.equal(app.environment.FUKULOW_COOKIE_SECURE, 'true')
  assert.equal(app.environment.FUKULOW_TRUSTED_PROXIES, configured.FUKULOW_TRUSTED_PROXIES)
  assert.equal(app.environment.FUKULOW_CLIENT_IP_HEADER, configured.FUKULOW_CLIENT_IP_HEADER)
  for (const profile of ['caddy', 'nginx']) {
    const bundled = render(profile, [], configured)
    assert.ok(bundled[profile])
    assert.equal(bundled.app.ports, undefined)
    assert.equal(bundled.app.environment.FUKULOW_ALLOWED_HOST, undefined)
    assert.equal(bundled.app.environment.FUKULOW_TRUSTED_PROXIES, '172.30.94.2')
    assert.equal(bundled.app.environment.FUKULOW_CLIENT_IP_HEADER, 'x-forwarded-for')
    assert.deepEqual(Object.keys(render(profile, [file], domain)).sort(), ['db', 'migrate'])
  }
  const externalDb = render('none', ['compose.external-db.yml', file], { ...domain,
    FUKULOW_APP_DATABASE_URL: 'postgres://app@database.example/fukulow?sslmode=verify-full',
    FUKULOW_MIGRATE_DATABASE_URL: 'postgres://owner@database.example/fukulow?sslmode=verify-full' })
  assert.deepEqual(Object.keys(externalDb).sort(), ['app', 'migrate'])
  assert.deepEqual(externalDb.app.ports, defaults.app.ports)
  assert.equal(externalDb.app.environment.PGSSLMODE, 'verify-full')
  assert.ok(!externalDb.app.environment.DATABASE_URL.includes('owner'))
})

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
  const app = readFileSync(new URL('../server/src/security_headers.rs', import.meta.url), 'utf8')
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
