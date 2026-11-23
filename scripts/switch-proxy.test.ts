// #810 deploy/switch-proxy.sh decisions against a stub docker/curl: switches in every direction
// between caddy, nginx and none, refusals that change nothing, and rollback after a failed switch.
// The real Compose run is scripts/check-compose-switch.ts (Pebble, e2e-compose).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

type Mode = 'caddy' | 'nginx' | 'none'
type State = { running: string[], created: string[], bindings: Record<string, string>,
  failStart: string[], https: Record<string, boolean>, calls: string[] }
const script = fileURLToPath(new URL('../deploy/switch-proxy.sh', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'switch-proxy-'))
const stateFile = join(directory, 'state.json')
after(() => rmSync(directory, { recursive: true, force: true }))

// Containers are named by service; each proxy has its own loopback 443 so curl can tell them apart.
const address: Record<string, string> = { caddy: '127.0.0.1:4431', nginx: '127.0.0.1:4432' }
const external = '127.0.0.1:9443'
writeFileSync(join(directory, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'))
const save = () => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state))
const argv = process.argv.slice(2)
const out = text => { if (text) process.stdout.write(text + '\\n') }
if (argv[0] === 'inspect') { out(state.bindings[argv.at(-1)]); process.exit(0) }
const profiles = []
let overlay = false
let i = 1
while (!['config', 'ps', 'up', 'stop', 'exec', 'port'].includes(argv[i])) {
  if (argv[i] === '--profile') profiles.push(argv[++i])
  if (argv[i].endsWith('compose.external-proxy.yml')) overlay = true
  i++
}
const [command, ...rest] = argv.slice(i)
const services = rest.filter(arg => !arg.startsWith('-') && !/^[0-9]+$/.test(arg))
state.calls.push([command, ...rest].join(' ') + (overlay ? ' (external overlay)' : ''))
const active = profiles.length ? profiles : (process.env.COMPOSE_PROFILES || '').split(',')
let status = 0
// Like older Compose: a named proxy whose profile is not active is no such service.
const inactive = services.find(s => ['caddy', 'nginx'].includes(s) && !active.includes(s))
if (command !== 'config' && inactive) { process.stderr.write('no such service: ' + inactive + '\\n'); save(); process.exit(1) }
if (command === 'config') out((overlay
  ? (active.includes('none') ? ['app'] : [])
  : ['app', ...['caddy', 'nginx'].filter(p => active.includes(p))]).join('\\n'))
if (command === 'ps') out(services.filter(s => state.running.includes(s) || (rest.includes('-aq') && state.created.includes(s))).join('\\n'))
if (command === 'up' && rest.includes('--no-start')) state.created.push(...services)
else if (command === 'up') {
  if (services.some(s => state.failStart.includes(s))) status = 1
  else state.running.push(...services.filter(s => !state.running.includes(s)))
}
if (command === 'stop') state.running = state.running.filter(s => !services.includes(s))
if (command === 'exec' || command === 'port') {
  if (!state.running.includes(services[0])) status = 1
  else out(command === 'port' ? ${JSON.stringify(address)}[services[0]] : 'fukulow.test')
}
save()
process.exit(status)
`)
// Verified only when the endpoint behind --connect-to is up and marked as serving trusted HTTPS.
writeFileSync(join(directory, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'))
const argv = process.argv.slice(2)
const target = (argv[argv.indexOf('--connect-to') + 1] || '').replace(/^::/, '')
const proxy = Object.entries(${JSON.stringify(address)}).find(([, a]) => a === target)?.[0]
const up = proxy ? state.running.includes(proxy) && state.https[proxy] : target === ${JSON.stringify(external)} && state.https.external
state.calls.push('curl ' + (proxy || target))
fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(state))
if (!up || !argv.at(-1).endsWith('/api/v1/health')) process.exit(7)
process.stdout.write('ok')
`)
chmodSync(join(directory, 'docker'), 0o755)
chmodSync(join(directory, 'curl'), 0o755)

const loopback = '443/tcp=127.0.0.1:443 80/tcp=127.0.0.1:80 '
function run(target: string, running: string[], { profiles = target, options = [] as string[], env = {} as Record<string, string>,
  state = {} as Partial<State> } = {}) {
  const initial: State = { running, created: [...running], bindings: { caddy: loopback, nginx: loopback },
    failStart: [], https: { caddy: true, nginx: true, external: true }, calls: [], ...state }
  writeFileSync(stateFile, JSON.stringify(initial))
  const result = spawnSync('bash', [script, target, ...options], { encoding: 'utf8', env: { PATH: `${directory}:${process.env.PATH}`,
    COMPOSE_PROFILES: profiles, SWITCH_PROXY_HTTPS_TIMEOUT: '0', SWITCH_PROXY_URL: 'https://fukulow.test',
    SWITCH_PROXY_CONNECT_TO: external, ...env } })
  const after: State = JSON.parse(readFileSync(stateFile, 'utf8'))
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, after,
    proxies: after.running.filter(s => s in address).sort() }
}
const changes = (calls: string[]) => calls.filter(call => /^(stop|up -d)/.test(call))

const modes: Mode[] = ['caddy', 'nginx', 'none']
for (const from of modes) for (const to of modes) {
  if (from === to) continue
  test(`switching ${from} -> ${to} leaves only ${to === 'none' ? 'no bundled proxy' : to} running`, () => {
    const result = run(to, from === 'none' ? [] : [from])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.proxies, to === 'none' ? [] : [to])
    // The previous proxy stops before the target starts, and HTTPS is verified afterwards.
    const calls = result.after.calls
    const stop = calls.findIndex(call => call.startsWith('stop'))
    const verify = calls.findIndex((call, at) => at > stop && call === `curl ${to === 'none' ? external : to}`)
    assert.ok(stop >= 0 && verify > stop)
    if (to !== 'none') {
      const start = calls.findIndex(call => call.startsWith('up -d'))
      assert.ok(start > stop && start < verify, calls.join('\n'))
    }
    assert.match(result.stdout, to === 'none' ? /^switch-proxy: none: https:\/\/fukulow\.test serves verified HTTPS/m
      : new RegExp(`^switch-proxy: ${to} is serving verified HTTPS; ${from === 'none' ? 'no other proxy' : from} is stopped`, 'm'))
  })
}

test('active profiles that do not select exactly the target are refused before anything changes', () => {
  for (const [target, profiles] of [['none', 'caddy'], ['nginx', 'caddy'], ['nginx', 'caddy,nginx'], ['caddy', '']]) {
    const result = run(target, ['caddy'], { profiles })
    assert.equal(result.status, 2)
    assert.match(result.stderr, new RegExp(`set COMPOSE_PROFILES=${target} in \\.env \\(nothing changed\\)`))
    assert.deepEqual(changes(result.after.calls), [])
    assert.deepEqual(result.proxies, ['caddy'])
  }
})

test('none without an https SWITCH_PROXY_URL is refused before anything changes', () => {
  for (const url of ['', 'http://fukulow.test', 'https://']) {
    const result = run('none', ['caddy'], { env: { SWITCH_PROXY_URL: url } })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /none needs SWITCH_PROXY_URL=https:\/\/<domain>.*\(nothing changed\)$/m)
    assert.deepEqual(result.after.calls, [])
  }
})

test('a target publishing other ports than the running proxy is refused before anything changes', () => {
  const result = run('nginx', ['caddy'], { state: { bindings: { caddy: loopback, nginx: '443/tcp=:443 80/tcp=:80 ' } } })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /nginx would publish .* but caddy publishes .*\(nothing changed\)$/m)
  assert.deepEqual(changes(result.after.calls), [])
  assert.deepEqual(result.proxies, ['caddy'])
})

test('a failed switch stops the target and restores the previous proxy with its HTTPS check', () => {
  for (const [target, previous, state] of [
    ['nginx', 'caddy', { failStart: ['nginx'] }],
    ['caddy', 'nginx', { https: { caddy: false, nginx: true, external: true } }],
    ['none', 'caddy', { https: { caddy: true, nginx: true, external: false } }],
    ['none', 'nginx', { https: { caddy: true, nginx: true, external: false } }],
  ] as const) {
    const result = run(target, [previous], { state })
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`^switch-proxy: restoring ${previous}; set COMPOSE_PROFILES=${previous} in \\.env again$`, 'm'))
    assert.deepEqual(result.proxies, [previous])
    assert.equal(result.after.calls.at(-1), `curl ${previous}`)
  }
})

test('a failed switch from none starts no proxy that was not running', () => {
  for (const target of ['caddy', 'nginx'] as const) {
    const result = run(target, [], { state: { failStart: [target] } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^switch-proxy: no other proxy was running, so none is started$/m)
    assert.deepEqual(result.proxies, [])
  }
})

test('external overlay is applied only to the none app and removed on bundled rollback', () => {
  const options = ['-f', 'compose.yml', '-f', 'compose.external-proxy.yml']
  const result = run('none', ['nginx'], { options, state: { https: { caddy: true, nginx: true, external: false } } })
  assert.equal(result.status, 1)
  assert.deepEqual(result.proxies, ['nginx'])
  assert.deepEqual(changes(result.after.calls), [
    'stop caddy', 'stop nginx', 'up -d --wait --wait-timeout 120 app (external overlay)',
    'up -d --wait --wait-timeout 120 nginx',
  ])
  const inactive = run('none', ['nginx'], { options, profiles: '' })
  assert.equal(inactive.status, 2)
  assert.match(inactive.stderr, /external-proxy overlay needs COMPOSE_PROFILES=none/)
  assert.deepEqual(changes(inactive.after.calls), [])
})
