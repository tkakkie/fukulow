// Reconciles statically found Rust tests with the runnable tests that `cargo nextest list` reports.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { Known } from './check-invariants.ts'

/** One runnable test from `cargo nextest list`, identified by its binary and full test name. */
export type ListedTest = { binary: string; name: string }

/** Downgrades Rust tests whose module-tree position is unsure or whose exact listed name is missing from its binary. */
export function reconcileWithCargoList(known: Known, listed: ListedTest[]): Known {
  const out: Known = new Map(known)
  const have = new Set(listed.map((t) => `${t.binary}\0${t.name}`))
  for (const [ref, status] of known) {
    if (!status.runs || !ref.startsWith('server/')) continue
    const missing = (status.expect ?? []).filter((e) => !have.has(`${e.binary}\0${e.name}`))
    if (status.refuse) out.set(ref, { runs: false, reason: status.refuse })
    else if (!status.expect?.length) out.set(ref, { runs: false, reason: 'has no known position in a cargo test binary' })
    else if (missing.length > 0)
      out.set(ref, {
        runs: false,
        reason: `is not runnable in \`cargo nextest list\` for ${missing.map((e) => `${e.binary} as \`${e.name}\``).join(', ')} (cfg-excluded, not compiled, or skipped)`,
      })
  }
  return out
}

type NextestSuite = {
  'package-name': string
  'binary-name': string
  kind: string
  status: string
  testcases: Record<string, { kind: string; 'filter-match': { status: string } }>
}

/** Lists runnable server tests across all CI shards. Throws if cargo or nextest is unavailable. */
export function cargoList(root: string): ListedTest[] {
  const pkg = /^name\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, 'server/Cargo.toml'), 'utf8'))?.[1]
  if (!pkg) throw new Error('Cannot map the nextest list without a package name in server/Cargo.toml')
  // Match the workspace package selection, features and Cargo profile of server-tests in ci.yml.
  const args = ['nextest', 'list', '--locked', '--features', 'fukulow-client-core/wasm', '--message-format', 'json']
  const r = spawnSync('cargo', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
  })
  if (r.error || r.status !== 0)
    throw new Error(`\`cargo ${args.join(' ')}\` failed (cargo is required, with nextest):\n${r.error ?? ''}${r.stderr ?? ''}`)

  const { 'rust-suites': suites } = JSON.parse(r.stdout) as { 'rust-suites': Record<string, NextestSuite> }
  const listed: ListedTest[] = []
  for (const suite of Object.values(suites)) {
    if (suite['package-name'] !== pkg || suite.status !== 'listed') continue
    let binary: string
    if (suite.kind === 'lib') binary = 'src/lib.rs'
    else if (suite.kind === 'bin' && suite['binary-name'] === pkg) binary = 'src/main.rs'
    else if (suite.kind === 'test') binary = `tests/${suite['binary-name']}.rs`
    else continue

    for (const [name, testcase] of Object.entries(suite.testcases))
      if (testcase.kind === 'test' && testcase['filter-match'].status === 'matches') listed.push({ binary, name })
  }
  if (listed.length === 0) throw new Error('`cargo nextest list` printed no runnable server tests')
  return listed
}
