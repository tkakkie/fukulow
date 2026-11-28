import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

type RunOptions = Pick<SpawnSyncOptions, 'cwd' | 'env' | 'input' | 'timeout' | 'maxBuffer'> & {
  failureOutput?: 'suppress' | 'stderr' | 'both'
}

export function run(command: string, args: readonly string[], {
  cwd, env, input, timeout, maxBuffer = 1024 * 1024, failureOutput = 'suppress',
}: RunOptions = {}): { stdout: string; stderr: string } {
  let result
  try {
    result = spawnSync(command, args, { cwd, env, input, timeout, maxBuffer, encoding: 'utf8', stdio: 'pipe' })
  } catch {
    // Argument validation errors can include the supplied values.
    throw new Error('Command could not be started')
  }
  if (result.status === 0 && !result.error) return { stdout: result.stdout, stderr: result.stderr }

  if (failureOutput === 'both' && result.stdout) process.stdout.write(result.stdout)
  if ((failureOutput === 'stderr' || failureOutput === 'both') && result.stderr) process.stderr.write(result.stderr)
  // Child-process errors can include arguments, input or captured output.
  throw new Error(result.error || result.status === null ? 'Command failed to complete' : `Command exited with status ${result.status}`)
}

export function psql<T>(docker: (args: string[]) => T, execArgs: readonly string[], args: readonly string[]): T {
  return docker([...execArgs, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', ...args])
}

type HealthResponse = { status: number; body: string }

export async function pollHealth(label: string,
  probe: (path: string) => HealthResponse | undefined | Promise<HealthResponse | undefined>, milliseconds?: number): Promise<void> {
  // The probe can return undefined for a transient connection failure.
  await poll(label, () => probe('/api/v1/health'), response => response?.status === 200 && response.body === 'ok', milliseconds)
}

// Observers signal a retry through the acceptance predicate. Observation errors propagate immediately.
export async function poll<T>(label: string, observe: () => Promise<T> | T, accept: (value: T) => boolean, milliseconds = 120_000): Promise<T> {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const value = await observe()
    if (accept(value)) return value
    await setTimeout(250)
  }
  throw new Error(`${label}: observable state did not converge within ${milliseconds}ms`)
}

export const nodeImage = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').match(/^FROM (node:\S+) AS web$/m)?.[1] ?? ''
assert.match(nodeImage, /^node:\d+\.\d+\.\d+-slim@sha256:[a-f0-9]{64}$/, 'reuse the pinned Node toolchain image')
