import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(command: string, args: string[], env = process.env): string {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`)
  return result.stdout.trim()
}

export function buildDriver(): string {
  const sysroot = run('rustc', ['--print', 'sysroot'])
  const source = join(root, 'scripts/module-direction.rs')
  const hash = createHash('sha256').update(readFileSync(source)).update(run('rustc', ['-Vv'])).digest('hex')
  // Cargo hashes the wrapper path into artifact names. Changing the checker must
  // invalidate checked artifacts, while ordinary dependency builds stay reusable.
  const directory = join(root, 'target/module-direction', hash)
  mkdirSync(directory, { recursive: true })
  const driver = join(directory, 'module-direction')
  // rustc-dev supplies real name resolution without a parser/name-resolver dependency.
  // Bootstrap is limited to compiling this development tool, never the application.
  run('clippy-driver', [
    '--edition=2024', '--crate-name', 'module_direction', '-Dwarnings',
    '-C', 'rpath=yes', '-L', join(sysroot, 'lib'),
    source, '-o', driver,
  ], { ...process.env, RUSTC_BOOTSTRAP: 'module_direction' })
  return driver
}

export function checkWorkspace(driver: string): void {
  run('cargo', ['check', '--locked', '--all-targets'], {
    ...process.env,
    RUSTC_WORKSPACE_WRAPPER: driver,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkWorkspace(buildDriver())
    console.log('Module direction: production and test targets passed')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
