import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const credentials = /ACTIONS_(?:RUNTIME_TOKEN|RESULTS_URL)/
const privilegedAction = /actions\/github-script/
const action = 'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3'
const allowed = new Set(['ci.yml/docker/build-image', 'ci.yml/docker/build-upgrade-image',
  'e2e-compose.yml/acceptance/build-image'])
const guard = 'if (!process.env.ACTIONS_RESULTS_URL || !process.env.ACTIONS_RUNTIME_TOKEN) {'

// Deliberately accepts only the repo's block-style steps/scripts at these three
// locations. Other YAML forms containing credential references fail closed.
// github-script also gets credentials implicitly, even without naming them.
function checkWorkflow(file: string, workflow: string) {
  const scripts = new Map<string, string>()
  let remaining = workflow
  for (const match of workflow.matchAll(/^      - [^\n]*(?:\n(?: {8}[^\n]*|[ \t]*))*/gm)) {
    const step = match[0]
    if (!credentials.test(step) && !privilegedAction.test(step)) continue
    const job = [...workflow.slice(0, match.index).matchAll(/^  ([\w-]+):/gm)].at(-1)?.[1]
    const id = step.match(/^        id: ([\w-]+)$/m)?.[1]
    const key = `${file}/${job}/${id}`
    assert.ok(allowed.has(key), 'cache credentials may only appear in allowed build steps')
    assert.ok(!scripts.has(key), 'credential build step must be unique')
    assert.ok(step.includes(`        uses: ${action} # v9.0.0`), 'credential build action must stay pinned')
    const body = step.match(/^          script: \|\n((?: {12}[^\n]*(?:\n|$)|\n)+)/m)?.[1]
    assert.ok(body, 'credential build must use a block script')
    assert.ok(!credentials.test(step.replace(body, '')), 'credentials must stay inside the build script')
    const script = body.replace(/^ {12}/gm, '').trim()
    assert.ok(script.includes(guard), 'build must require both cache credentials')
    assert.ok(!credentials.test(script.replace(guard, '')), 'credentials may only be read by the availability guard')
    assert.doesNotMatch(script, /exportVariable|GITHUB_ENV|GITHUB_OUTPUT|setOutput|saveState|writeFile|appendFile/,
      'build credentials must never be stored or exported')
    assert.doesNotMatch(script.replace(guard, '').replaceAll(/process\.env\.(?:PATH|RUNNER_TEMP)\b/g, ''),
      /process\s*(?:\.|\[)/, 'build scripts may not forward or log the whole environment')
    const calls = [...script.matchAll(/exec\.exec\("([^"]+)"/g)]
    assert.equal(calls.length, [...script.matchAll(/exec\.exec/g)].length, 'child commands must be literal')
    for (const [, command] of calls) assert.ok(['docker', 'git', 'tar'].includes(command), 'only build commands may run in credential steps')
    scripts.set(key, script)
    remaining = remaining.replace(step, '')
  }
  assert.ok(!credentials.test(remaining) && !privilegedAction.test(remaining),
    'cache credentials may only appear in allowed build steps')
  return scripts
}

test('every workflow confines cache credentials to pinned build actions; CI runs this regression check', () => {
  const found = new Set<string>()
  for (const file of readdirSync(new URL('../.github/workflows/', import.meta.url)).filter(file => /\.ya?ml$/.test(file))) {
    for (const key of checkWorkflow(file, read(`.github/workflows/${file}`)).keys()) found.add(key)
  }
  assert.deepEqual(found, allowed)
  assert.match(read('.github/workflows/ci.yml'), /run: node --test scripts\/\*\.test\.ts/)
})

test('rejects credential exports and file/output stores in any workflow, including allowed build steps', () => {
  const workflow = read('.github/workflows/ci.yml')
  for (const variable of ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL']) {
    for (const source of [
      `core.exportVariable("${variable}", process.env.${variable});`,
      `core.exportVariable("${variable}", "test-only");`,
      `echo "${variable}=$value" >> "$GITHUB_ENV"`,
      `echo "${variable}=$value" >> "$GITHUB_OUTPUT"`,
      `fs.writeFileSync("cache-token", process.env.${variable});`,
      `core.setOutput("token", process.env.${variable});`,
    ]) {
      assert.throws(() => checkWorkflow('ci.yml', workflow.replace(guard, `${source}\n            ${guard}`)), /credentials/)
      const extra = `name: test\njobs:\n  check:\n    steps:\n      - run: |\n          ${source}\n`
      assert.throws(() => checkWorkflow('new.yaml', extra), /allowed build steps/)
    }
  }
  // An alias must not bypass the store check after a whole-environment read.
  assert.throws(() => checkWorkflow('ci.yml', workflow.replace(guard,
    `const env = process.env;\n            core.exportVariable("alias", env);\n            ${guard}`)), /stored or exported/)
})

test('rejects job/workflow env, unrelated steps, renamed actions, and credential-enabled repository commands', () => {
  const workflow = read('.github/workflows/ci.yml')
  for (const variable of ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL']) {
    for (const source of [
      workflow.replace('jobs:', `env: { ${variable}: test-only }\njobs:`),
      workflow.replace('  docker:\n', `  docker:\n    env: { ${variable}: test-only }\n`),
      workflow + `\n      - run: node scripts/check-db-upgrade.ts\n        env: { ${variable}: test-only }\n`,
      workflow + `\n      - uses: actions/github-script@v9\n        with:\n          script: console.log(process.env.${variable})\n`,
      workflow.replace(guard, `${guard}\n              console.log(process.env.${variable});`),
    ]) assert.throws(() => checkWorkflow('ci.yml', source), /credentials|allowed build steps/)
  }
  assert.throws(() => checkWorkflow('ci.yml', workflow.replace('id: build-image', 'id: checks')), /allowed build steps/)
  assert.throws(() => checkWorkflow('ci.yml', workflow.replace(action, 'actions/github-script@v9')), /stay pinned/)
  assert.throws(() => checkWorkflow('ci.yml', workflow.replace('await exec.exec("docker", args);',
    'await exec.exec("node", ["scripts/check-db-upgrade.ts"]);')), /only build commands/)
  for (const source of [
    '      - uses: actions/github-script@v9\n        with:\n          script: await exec.exec("node", ["scripts/check-db-upgrade.ts"]);',
    '      - uses:  actions/github-script@v9',
    '      - uses: "actions/github-script@v9"',
    '      - uses: >-\n          actions/github-script@v9',
    '      - { uses: actions/github-script@v9 }',
  ]) assert.throws(() => checkWorkflow('ci.yml', `${workflow}\n${source}\n`), /allowed build steps/)
})

async function buildCalls(script: string, eventName: string) {
  const env = { PATH: '/test/bin', RUNNER_TEMP: '/test/tmp',
    ACTIONS_RUNTIME_TOKEN: 'test-only-token', ACTIONS_RESULTS_URL: 'https://cache.invalid' }
  const calls: { command: string, args: string[], credentials: boolean }[] = []
  const fs = { mkdtempSync: () => '/test/source', rmSync: () => {} }
  const modules: Record<string, unknown> = { 'node:fs': fs, 'node:path': { join }, 'node:os': { tmpdir: () => '/test/tmp' } }
  await runInNewContext(`(async () => { ${script}\n })()`, {
    process: { env }, context: { eventName },
    require: (name: string) => { assert.ok(Object.hasOwn(modules, name)); return modules[name] },
    console: { log: () => assert.fail('build must not log credentials') },
    exec: { exec: async (command: string, args: string[], options?: { env?: Record<string, string> }) => {
      const child = options?.env ?? env
      const hasCredentials = !!(child.ACTIONS_RUNTIME_TOKEN || child.ACTIONS_RESULTS_URL)
      if (hasCredentials) {
        assert.equal(command, 'docker', 'only docker builds may inherit credentials')
        assert.equal(args[0], 'buildx')
        assert.ok(['bake', 'build'].includes(args[1]))
      }
      calls.push({ command, args: Array.from(args), credentials: hasCredentials })
    } },
  })
  return calls
}

test('child-environment guard rejects implicit credentials on archive helpers and non-build docker commands', async () => {
  const scripts = checkWorkflow('ci.yml', read('.github/workflows/ci.yml'))
  const oldBuild = scripts.get('ci.yml/docker/build-upgrade-image')!
  await assert.rejects(() => buildCalls(oldBuild.replaceAll(', { env });', ');'), 'push'), /only docker builds/)
  const mainBuild = scripts.get('ci.yml/docker/build-image')!
  await assert.rejects(() => buildCalls(mainBuild.replace('"buildx", "bake"', '"compose", "up"'), 'push'), /buildx/)
})

test('PR and push builds retain cache policy; old-image helpers never receive credentials', async () => {
  for (const event of ['pull_request', 'push']) {
    for (const file of ['ci.yml', 'e2e-compose.yml']) {
      for (const [key, script] of checkWorkflow(file, read(`.github/workflows/${file}`))) {
        const calls = await buildCalls(script, event)
        const builds = calls.filter(call => call.credentials)
        assert.equal(builds.length, 1)
        const build = builds[0]
        assert.ok(build.args.some(arg => arg.includes('cache-from=type=gha,scope=docker')) ||
          build.args.includes('--cache-from') && build.args.includes('type=gha,scope=docker'))
        const writes = build.args.includes('app.cache-to=type=gha,scope=docker,mode=max')
        assert.equal(writes, key.endsWith('build-upgrade-image') ? false : file === 'e2e-compose.yml' || event === 'push')
        if (key.endsWith('build-upgrade-image')) {
          assert.deepEqual(calls.map(call => [call.command, call.credentials]), [['git', false], ['tar', false], ['docker', true]])
          assert.ok(build.args.includes('fukulow-upgrade-main'))
        }
      }
    }
  }
})

test('upgrade reuses the prebuilt image; local builds skip gha cache unless both step credentials exist', t => {
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-cache-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const log = join(directory, 'calls')
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args,
  token: !!process.env.ACTIONS_RUNTIME_TOKEN, url: !!process.env.ACTIONS_RESULTS_URL }) + '\\n');
if (args.includes('config')) {
  const file = args[args.indexOf('-f', args.indexOf('-f') + 1) + 1];
  const image = file && file.endsWith('main-override.yml') ? fs.readFileSync(file, 'utf8').match(/image: (.+)/)[1] : 'unused';
  console.log(JSON.stringify({ services: { app: { image }, migrate: { image } } }));
}
// Stop before starting containers; the check's finally still exercises cleanup.
if (args.includes('up')) process.exit(88);
`, { mode: 0o700 })
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  for (const scenario of ['prebuilt', 'absent', 'token-only', 'url-only', 'both']) {
    writeFileSync(log, '')
    const cached = scenario === 'both'
    const result = spawnSync(process.execPath, ['scripts/check-db-upgrade.ts'], { cwd, encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: directory, CHECK_UPGRADE_REVISION: 'HEAD',
        CHECK_COMPOSE_IMAGE: 'candidate', CHECK_UPGRADE_CACHE_FROM: 'type=gha,scope=docker',
        ...(scenario === 'prebuilt' ? { CHECK_UPGRADE_OLD_IMAGE: 'fukulow-upgrade-main' } : {}),
        ...(['both', 'token-only'].includes(scenario) ? { ACTIONS_RUNTIME_TOKEN: 'test-only-sentinel' } : {}),
        ...(['both', 'url-only'].includes(scenario) ? { ACTIONS_RESULTS_URL: 'https://cache.invalid' } : {}),
      } })
    assert.notEqual(result.status, 0, 'fixture must stop before running containers')
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-sentinel|https:\/\/cache.invalid/)
    const calls: { args: string[], token: boolean, url: boolean }[] = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.ok(calls.some(call => call.args.includes('up')), 'must reach container startup after the build')
    const builds = calls.filter(call => call.args[0] === 'build' || call.args[0] === 'buildx')
    assert.equal(builds.length, scenario === 'prebuilt' ? 0 : 1)
    for (const call of calls) {
      const build = builds.includes(call)
      assert.equal(call.token, build && cached)
      assert.equal(call.url, build && cached)
      if (build) {
        assert.equal(call.args.includes('--cache-from'), cached)
        if (cached) assert.ok(call.args.includes('type=gha,scope=docker'))
      }
    }
  }
})
