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
const allowed = new Set(['ci.yml/docker-proxy/build-image', 'ci.yml/docker-ops/build-image',
  'ci.yml/docker-ops/build-upgrade-image', 'e2e-compose.yml/acceptance/build-image'])
// Jobs that hold a credential build step, per workflow.
const credentialJobs: Record<string, string[]> = { 'ci.yml': ['docker-proxy', 'docker-ops'], 'e2e-compose.yml': ['acceptance'] }
// Each variant replaces exactly one occurrence, so every credential step is mutated on its own.
function eachReplacement(text: string, from: string, to: string) {
  const variants: string[] = []
  for (let at = text.indexOf(from); at >= 0; at = text.indexOf(from, at + 1)) variants.push(text.slice(0, at) + to + text.slice(at + from.length))
  assert.ok(variants.length > 0, `missing ${JSON.stringify(from)}`)
  return variants
}
// Replaces the first match at or after the job header, so identical blocks in other jobs stay untouched.
function replaceInJob(text: string, job: string, from: string, to: string) {
  const at = text.indexOf(from, text.indexOf(`  ${job}:\n`))
  assert.ok(text.indexOf(`  ${job}:\n`) >= 0 && at >= 0, `missing ${JSON.stringify(from)} in ${job}`)
  return text.slice(0, at) + to + text.slice(at + from.length)
}
const guard = 'if (!process.env.ACTIONS_RESULTS_URL || !process.env.ACTIONS_RUNTIME_TOKEN) {'
const inheritedEnvKeys = new Set(['COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'POSTGRES_PASSWORD',
  'POSTGRES_APP_PASSWORD', 'FUKULOW_SETUP_TOKEN', 'FUKULOW_COOKIE_SECURE', 'FUKULOW_DOMAIN'])

function checkInheritedEnv(scope: string, indent: number) {
  // Reject quoted/merged mapping keys at these scopes rather than miss an env
  // alias or an alternate YAML spelling. Unrelated steps/jobs are not inspected.
  for (const [line] of scope.matchAll(new RegExp(`^ {${indent}}\\S[^\\n]*$`, 'gm'))) {
    if (line.trimStart().startsWith('#')) continue
    assert.match(line, new RegExp(`^ {${indent}}[\\w-]+:(?:[ \\t]|$)`),
      'inherited environment for cache credentials requires plain mapping keys')
  }
  const lines = scope.split('\n')
  for (let index = 0; index < lines.length; index++) {
    if (!new RegExp(`^ {${indent}}env:`).test(lines[index])) continue
    assert.match(lines[index], /^ *env: *(?:#.*)?$/, 'inherited environment for cache credentials must use a block mapping')
    for (index++; index < lines.length; index++) {
      const line = lines[index]
      // YAML comments and blank lines never end a mapping, even when outdented.
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      if (line.match(/^ */)![0].length <= indent) {
        assert.match(line, /^ *[\w-]+:(?:[ \t]|$)/,
          'inherited environment for cache credentials requires plain mapping keys')
        index--
        break
      }
      const key = line.match(new RegExp(`^ {${indent + 2}}([A-Z_][A-Z0-9_]*): .+$`))?.[1]
      assert.ok(key && inheritedEnvKeys.has(key), 'inherited environment key for cache credentials must be allowlisted')
    }
  }
}

function checkActionInputs(step: string, body: string) {
  const seen = new Set<string>()
  for (const line of step.replace(body, '').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const key = line.match(/^(?:      - |        )(name|id|uses|if|timeout-minutes|continue-on-error): .+$/)?.[1]
      ?? (line === '        with:' ? 'with' : undefined)
      ?? (line === '          script: |' ? 'script' : undefined)
    assert.ok(key && !seen.has(key), 'credential build steps allow only metadata and the script input; no step env')
    seen.add(key)
  }
}

// Deliberately accepts only the repo's block-style steps/scripts at these four
// locations. Other YAML forms containing credential references fail closed.
// github-script also gets credentials implicitly, even without naming them.
function checkWorkflow(file: string, workflow: string) {
  const scripts = new Map<string, string>()
  let remaining = workflow
  for (const match of workflow.matchAll(/^      - [^\n]*(?:\n(?: {8}[^\n]*|[ \t]*$))*/gm)) {
    const step = match[0]
    if (!credentials.test(step) && !privilegedAction.test(step)) continue
    const jobMatch = [...workflow.slice(0, match.index).matchAll(/^  ([\w-]+):/gm)].at(-1)
    const job = jobMatch?.[1]
    const id = step.match(/^        id: ([\w-]+)$/m)?.[1]
    const key = `${file}/${job}/${id}`
    assert.ok(allowed.has(key), 'cache credentials may only appear in allowed build steps')
    assert.ok(!scripts.has(key), 'credential build step must be unique')
    assert.ok(step.includes(`        uses: ${action} # v9.0.0`), 'credential build action must stay pinned')
    const body = step.match(/^          script: \|\n((?: {12}[^\n]*(?:\n|$)|\n)+)/m)?.[1]
    assert.ok(body, 'credential build must use a block script')
    checkActionInputs(step, body)
    checkInheritedEnv(workflow, 0)
    const jobStart = jobMatch!.index
    const jobEnd = workflow.slice(jobStart + 1).search(/^  [\w-]+:/m)
    checkInheritedEnv(workflow.slice(jobStart, jobEnd < 0 ? undefined : jobStart + 1 + jobEnd), 4)
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
      for (const mutated of eachReplacement(workflow, guard, `${source}\n            ${guard}`))
        assert.throws(() => checkWorkflow('ci.yml', mutated), /credentials/)
      const extra = `name: test\njobs:\n  check:\n    steps:\n      - run: |\n          ${source}\n`
      assert.throws(() => checkWorkflow('new.yaml', extra), /allowed build steps/)
    }
  }
  // An alias must not bypass the store check after a whole-environment read.
  for (const mutated of eachReplacement(workflow, guard,
    `const env = process.env;\n            core.exportVariable("alias", env);\n            ${guard}`))
    assert.throws(() => checkWorkflow('ci.yml', mutated), /stored or exported/)
})

test('rejects job/workflow env, unrelated steps, renamed actions, and credential-enabled repository commands', () => {
  const workflow = read('.github/workflows/ci.yml')
  for (const variable of ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL']) {
    for (const source of [
      workflow.replace('jobs:', `env: { ${variable}: test-only }\njobs:`),
      ...credentialJobs['ci.yml'].map(job => workflow.replace(`  ${job}:\n`, `  ${job}:\n    env: { ${variable}: test-only }\n`)),
      workflow + `\n      - run: node scripts/check-db-upgrade.ts\n        env: { ${variable}: test-only }\n`,
      workflow + `\n      - uses: actions/github-script@v9\n        with:\n          script: console.log(process.env.${variable})\n`,
      ...eachReplacement(workflow, guard, `${guard}\n              console.log(process.env.${variable});`),
    ]) assert.throws(() => checkWorkflow('ci.yml', source), /credentials|allowed build steps/)
  }
  for (const source of eachReplacement(workflow, 'id: build-image', 'id: checks'))
    assert.throws(() => checkWorkflow('ci.yml', source), /allowed build steps/)
  for (const source of eachReplacement(workflow, action, 'actions/github-script@v9'))
    assert.throws(() => checkWorkflow('ci.yml', source), /stay pinned/)
  for (const source of eachReplacement(workflow, 'await exec.exec("docker", args);',
    'await exec.exec("node", ["scripts/check-db-upgrade.ts"]);')) assert.throws(() => checkWorkflow('ci.yml', source), /only build commands/)
  for (const source of [
    '      - uses: actions/github-script@v9\n        with:\n          script: await exec.exec("node", ["scripts/check-db-upgrade.ts"]);',
    '      - uses:  actions/github-script@v9',
    '      - uses: "actions/github-script@v9"',
    '      - uses: >-\n          actions/github-script@v9',
    '      - { uses: actions/github-script@v9 }',
  ]) assert.throws(() => checkWorkflow('ci.yml', `${workflow}\n${source}\n`), /allowed build steps/)
})

test('credential actions reject startup env at every scope and inputs other than script', () => {
  const preloads = [
    ...['--import', '--require', '--loader', '--experimental-loader', '-r']
      .map(flag => ['NODE_OPTIONS', `${flag} ./scripts/check-db-upgrade.ts`]),
    ['NODE_PATH', './scripts'], ['LD_PRELOAD', './repository.so'],
    ['BASH_ENV', './repository.sh'], ['ENV', './repository.sh'],
    ['PYTHONPATH', './scripts'], ['PATH', './scripts'],
  ]
  for (const file of ['ci.yml', 'e2e-compose.yml']) for (const job of credentialJobs[file]) {
    const workflow = read(`.github/workflows/${file}`)
    const jobEnv = workflow.slice(workflow.indexOf(`  ${job}:\n`))
      .match(/^    env:[^\n]*(?:\n(?: {6}[^\n]*|[ \t]*$))*/m)![0]
    for (const [variable, value] of preloads) {
      for (const env of [`env:\n          ${variable}: ${value}`, `env: { ${variable}: "${value}" }`]) {
        for (const id of file === 'ci.yml' ? ['build-image', 'build-upgrade-image'] : ['build-image']) {
          for (const source of eachReplacement(workflow, `id: ${id}\n`, `id: ${id}\n        ${env}\n`))
            assert.throws(() => checkWorkflow(file, source), /no step env/)
        }
      }
      for (const env of [`env:\n  ${variable}: ${value}\n`, `env: { ${variable}: "${value}" }\n`]) {
        assert.throws(() => checkWorkflow(file, workflow.replace('jobs:', `${env}jobs:`)), /inherited environment/)
      }
      for (const env of [`env:\n      ${variable}: ${value}\n`, `env: { ${variable}: "${value}" }\n`]) {
        assert.throws(() => checkWorkflow(file, replaceInJob(workflow, job, jobEnv, `    ${env}`)), /inherited environment/)
      }
    }
    for (const extra of ['env: {}', 'env: *startup', 'env: ${{ vars.STARTUP }}',
      'with: { require: ./scripts/check-db-upgrade.ts }']) {
      for (const source of eachReplacement(workflow, 'id: build-image\n', `id: build-image\n        ${extra}\n`))
        assert.throws(() => checkWorkflow(file, source), /no step env/)
    }
    for (const input of ['require', 'pre-script', 'post-script', 'github-token']) {
      for (const source of eachReplacement(workflow, '          script: |', `          ${input}: ./scripts/check-db-upgrade.ts\n          script: |`))
        assert.throws(() => checkWorkflow(file, source), /only metadata and the script input/)
    }
    for (const env of ['env: *startup', 'env: ${{ vars.STARTUP }}', 'env:\n  <<: *startup',
      'env:\n  "NODE_OPTIONS": --import ./scripts/check-db-upgrade.ts',
      '"env": { NODE_OPTIONS: "--import ./scripts/check-db-upgrade.ts" }', '<<: *startup']) {
      assert.throws(() => checkWorkflow(file, workflow.replace('jobs:', `${env}\njobs:`)), /inherited environment/)
      assert.throws(() => checkWorkflow(file, replaceInJob(workflow, job, jobEnv,
        `    ${env.replaceAll('\n', '\n    ')}\n`)), /inherited environment/)
    }
  }
})

test('startup restrictions leave unrelated steps and jobs alone and allow known inherited settings', () => {
  const workflow = read('.github/workflows/ci.yml')
    .replace('jobs:', 'env:\n  COMPOSE_PROFILES: caddy\njobs:')
    .replace('  web:\n', '  web:\n    env: { NODE_OPTIONS: "--import ./web-check.ts" }\n')
    .replace('    steps:\n', '    steps:\n      - uses: unrelated/action@v1\n        env: { NODE_PATH: ./scripts }\n        with: { require: ./scripts/unrelated.ts }\n')
    .replace('      - name: Fetch upgrade source\n',
      '      - run: node scripts/unrelated.ts\n        env: { BASH_ENV: ./unrelated.sh }\n      - name: Fetch upgrade source\n')
  assert.equal(checkWorkflow('ci.yml', workflow).size, 3)
})

test('inherited env scans past comments at every indent and fails closed on unclassified lines', () => {
  for (const file of ['ci.yml', 'e2e-compose.yml']) for (const job of credentialJobs[file]) {
    const workflow = read(`.github/workflows/${file}`)
    const jobEnv = workflow.slice(workflow.indexOf(`  ${job}:\n`))
      .match(/^    env:[^\n]*(?:\n(?: {6}[^\n]*|[ \t]*$))*/m)![0]
    const expected = [...checkWorkflow(file, workflow).keys()]
    for (const indent of [0, 4]) {
      const prefix = ' '.repeat(indent)
      const insert = (env: string) => indent === 0
        ? workflow.replace('jobs:', `${env}jobs:`)
        : replaceInJob(workflow, job, jobEnv, env)
      // Cover workflow/job parent indentation, env indentation and entry indentation.
      for (const commentIndent of new Set([0, Math.max(0, indent - 2), indent, indent + 2])) {
        for (const betweenEntries of [false, true]) {
          for (const trailingComment of ['', ' # startup settings']) {
            const env = [
              `${prefix}env:${trailingComment}`,
              ...(betweenEntries ? [`${prefix}  COMPOSE_PROFILES: caddy`] : []),
              '', ' \t', `${' '.repeat(commentIndent)}# Node startup settings`, '',
              `${prefix}  NODE_OPTIONS: --import ./scripts/check-db-upgrade.ts`, '',
            ].join('\n')
            const context = `${file}, indent ${indent}, comment indent ${commentIndent}, between ${betweenEntries}, header ${trailingComment}`
            assert.throws(() => checkWorkflow(file, insert(env)), /inherited environment/, context)
            assert.deepEqual([...checkWorkflow(file, insert(env.replace(
              'NODE_OPTIONS: --import ./scripts/check-db-upgrade.ts', 'FUKULOW_DOMAIN: localhost'))).keys()], expected, context)
          }
        }
      }
      for (const line of ['\tNODE_OPTIONS: --import ./scripts/check-db-upgrade.ts',
        `${prefix}not-a-mapping`, `${prefix}  <<: *startup`,
        `${prefix}   NODE_OPTIONS: --import ./scripts/check-db-upgrade.ts`]) {
        const env = `${prefix}env: # startup settings\n# outdented comment\n${line}\n`
        assert.throws(() => checkWorkflow(file, insert(env)), /inherited environment/)
      }
    }
  }
})

type BuildCall = { command: string, args: string[], credentials: boolean }

async function buildCalls(script: string, eventName: string) {
  const env = { PATH: '/test/bin', RUNNER_TEMP: '/test/tmp',
    ACTIONS_RUNTIME_TOKEN: 'test-only-token', ACTIONS_RESULTS_URL: 'https://cache.invalid' }
  const calls: BuildCall[] = []
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

function checkOldImageBuild(calls: BuildCall[]) {
  assert.deepEqual(calls.map(call => [call.command, call.credentials]), [['git', false], ['tar', false], ['docker', true]])
  assert.deepEqual(calls[0].args, ['archive', '--format=tar', '--output', '/test/source.tar', 'origin/main'],
    'old-image archive must use origin/main')
  assert.equal(calls[2].args[calls[2].args.indexOf('-t') + 1], 'fukulow-upgrade-main')
}

function checkOldImageCleanup(calls: { args: string[] }[], image: string) {
  assert.deepEqual(calls.filter(call => call.args[0] === 'image' && call.args[1] === 'rm').map(call => call.args),
    [['image', 'rm', image]], 'cleanup must remove the supplied old-image tag')
}

test('old-image identity guard rejects a changed archive revision or build tag', async () => {
  const script = checkWorkflow('ci.yml', read('.github/workflows/ci.yml')).get('ci.yml/docker-ops/build-upgrade-image')!
  for (const [from, to] of [['"origin/main"', '"HEAD"'], ['"fukulow-upgrade-main"', '"wrong-image"']]) {
    const calls = await buildCalls(script.replace(from, to), 'push')
    assert.throws(() => checkOldImageBuild(calls), /origin\/main|fukulow-upgrade-main/)
  }
})

test('child-environment guard rejects implicit credentials on archive helpers and non-build docker commands', async () => {
  const scripts = checkWorkflow('ci.yml', read('.github/workflows/ci.yml'))
  const oldBuild = scripts.get('ci.yml/docker-ops/build-upgrade-image')!
  await assert.rejects(() => buildCalls(oldBuild.replaceAll(', { env });', ');'), 'push'), /only docker builds/)
  const mainBuild = scripts.get('ci.yml/docker-ops/build-image')!
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
        // Only one job per workflow writes the scope; docker-proxy reads main's layers only.
        assert.equal(writes, key.endsWith('build-upgrade-image') || key === 'ci.yml/docker-proxy/build-image' ? false
          : file === 'e2e-compose.yml' || event === 'push')
        if (key.endsWith('build-upgrade-image')) {
          checkOldImageBuild(calls)
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
    if (scenario === 'prebuilt') {
      checkOldImageCleanup(calls, 'fukulow-upgrade-main')
      for (const mutation of ['omit', 'wrong-tag']) {
        const broken = calls.flatMap(call => call.args[0] === 'image' && call.args[1] === 'rm'
          ? mutation === 'omit' ? [] : [{ ...call, args: ['image', 'rm', 'wrong-image'] }]
          : [call])
        assert.throws(() => checkOldImageCleanup(broken, 'fukulow-upgrade-main'), /supplied old-image tag/)
      }
    }
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
