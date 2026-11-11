import { spawn } from 'node:child_process'
import { randomInt, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const project = `fukulow-restart-${randomUUID()}`
const image = `${project}-app`
const helper = `${project}-kill`
const directory = mkdtempSync(join(tmpdir(), 'fukulow-restart-'))
const override = join(directory, 'restart.yml')
const stop = new AbortController()
const env = { ...process.env, CHECK_IMAGE: image, POSTGRES_PASSWORD: 'restart-check-only', FUKULOW_SETUP_TOKEN: 'restart-setup-test-only',
  POSTGRES_APP_PASSWORD: 'restart-app-test-only',
  // Separate from deployment defaults and the security check's second-octet range.
  FUKULOW_EDGE_PREFIX: process.env.CHECK_EDGE_PREFIX || `10.${randomInt(192, 256)}.${randomInt(256)}` }
const compose = ['compose', '--env-file', '/dev/null', '-p', project, '-f', 'compose.yml', '-f', override]

async function run(command: string, args: string[], allowFailure = false, cleaning = false) {
  const result = await new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root, env, signal: cleaning ? undefined : stop.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
  if (result.code !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} (exit ${result.code})\n${result.stdout}\n${result.stderr}`)
  }
  return result
}

async function dc(args: string[], cleaning = false) {
  return run('docker', [...compose, ...args], cleaning, cleaning)
}

async function inspect(container: string) {
  const { stdout } = await run('docker', ['inspect', container])
  const [state] = JSON.parse(stdout)
  return state as {
    RestartCount: number,
    State: { Pid: number, Status: string },
    HostConfig: { RestartPolicy: { Name: string } },
  }
}

async function waitHealth() {
  for (let attempt = 0; attempt < 60; attempt++) {
    // Docker may allocate a different port when the container restarts.
    const port = await run('docker', [...compose, 'port', 'app', '8080'], true)
    if (port.code === 0 && /^127\.0\.0\.1:\d+$/.test(port.stdout)) {
      try {
        const response = await fetch(`http://${port.stdout}/api/v1/health`, {
          signal: AbortSignal.any([stop.signal, AbortSignal.timeout(1000)]),
        })
        const body = await response.text()
        if (response.ok && body === 'ok') {
          console.log(`health ok: ${port.stdout}`)
          return
        }
      } catch {
        stop.signal.throwIfAborted()
      }
    }
    await delay(1000, undefined, { signal: stop.signal })
  }
  throw new Error('HTTP /api/v1/health did not recover within 60 attempts')
}

async function cleanup() {
  const results = [
    await run('docker', ['rm', '-f', helper], true, true),
    await dc(['down', '-v', '--remove-orphans'], true),
    await run('docker', ['image', 'rm', image], true, true),
  ]
  rmSync(directory, { recursive: true, force: true })
  // A helper may never have been created, or its --rm may already have removed it.
  for (const result of results.slice(1)) {
    if (result.code !== 0) {
      console.error(`Cleanup failed: ${result.stdout}\n${result.stderr}`)
      process.exitCode = 1
    }
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => stop.abort(new Error(`Interrupted by ${signal}`)))
}

try {
  writeFileSync(override, `services:
  migrate:
    image: \${CHECK_IMAGE}
  app:
    image: \${CHECK_IMAGE}
    container_name: ${project}-app
    ports: !override
      - "127.0.0.1::8080"
  db:
    container_name: ${project}-db
networks:
  edge:
    name: ${project}-network
volumes:
  postgres_data:
    name: ${project}-db
`)
  const sha = (await run('git', ['rev-parse', 'HEAD'])).stdout
  const dirty = (await run('git', ['status', '--porcelain'])).stdout !== ''
  console.log(`commit=${sha} dirty=${dirty} project=${project} edge=${env.FUKULOW_EDGE_PREFIX}.0/29`)
  console.log('Building release image (may take several minutes)...')
  await dc(['build', 'app'])
  await dc(['up', '-d', '--no-build'])
  const container = (await dc(['ps', '-q', 'app'])).stdout
  if (!container) throw new Error('Compose did not create the app container')
  await waitHealth()
  // Let Docker's restart-policy successful-start interval elapse first.
  await delay(10_000, undefined, { signal: stop.signal })
  const before = await inspect(container)
  if (before.HostConfig.RestartPolicy.Name !== 'unless-stopped') {
    throw new Error('App restart policy must be unless-stopped')
  }
  const main = await run('docker', ['exec', container, 'cat', '/proc/1/comm'])
  if (main.stdout !== 'fukulow-server') throw new Error(`Unexpected PID 1: ${main.stdout}`)
  const since = Math.floor(Date.now() / 1000).toString()
  // Namespace init normally ignores this; a non-zero exec exit is also expected.
  const killed = await run('docker', ['exec', container, 'sh', '-c', 'kill -KILL 1'], true)
  console.log(`in-container SIGKILL exit=${killed.code} ${killed.stderr}`)
  await delay(2000, undefined, { signal: stop.signal })
  const afterExec = await inspect(container)
  console.log(`RestartCount after exec: ${before.RestartCount}->${afterExec.RestartCount}`)
  if (afterExec.RestartCount === before.RestartCount) {
    if (afterExec.State.Pid !== before.State.Pid || before.State.Pid <= 0) {
      throw new Error('App main process changed before host-namespace kill')
    }
    console.log(`host-namespace SIGKILL of same main process: pid=${before.State.Pid}`)
    const killed = await run('docker', [
      'run', '--rm', '--name', helper, '--pid=host', '--entrypoint', 'sh', 'postgres:18',
      '-c', 'kill -KILL "$1"', 'sh', String(before.State.Pid),
    ], true)
    console.log(`host-namespace kill exit=${killed.code} ${killed.stderr}`)
  }
  let after = await inspect(container)
  for (let attempt = 0; attempt < 60 && after.RestartCount <= before.RestartCount; attempt++) {
    await delay(1000, undefined, { signal: stop.signal })
    after = await inspect(container)
  }
  if (after.RestartCount <= before.RestartCount) throw new Error('RestartCount did not increase')
  await waitHealth()
  await delay(1000, undefined, { signal: stop.signal })
  const events = await run('docker', [
    'events', '--since', since, '--until', Math.floor(Date.now() / 1000).toString(),
    '--filter', `container=${container}`, '--filter', 'event=die', '--format', '{{json .}}',
  ])
  const died = events.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .some(event => event.Actor.Attributes.exitCode === '137')
  if (!died) throw new Error(`Missing die exitCode=137 event: ${events.stdout}`)
  after = await inspect(container)
  if (after.State.Status !== 'running') throw new Error('App is not running after recovery')
  console.log(`PASS commit=${sha} dirty=${dirty} die exitCode=137 RestartCount ${before.RestartCount}->${after.RestartCount} health ok again`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await cleanup()
}
