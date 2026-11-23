import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const notice = 'Copyright (c) 2026 tkakkie and the fukulow contributors\nRust crates (2):\n  a 1\nnpm packages in the web bundle (1):\n  b 1\n'

function check(change: (dir: string) => void): { status: number | null, stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'image-licenses-'))
  for (const file of ['LICENSE-MIT', 'LICENSE-APACHE']) copyFileSync(join(root, file), join(dir, file))
  writeFileSync(join(dir, 'THIRD-PARTY-NOTICES.txt'), notice)
  change(dir)
  const result = spawnSync('bash', [join(root, 'scripts/check-image-licenses.sh'), '--dir', dir], { encoding: 'utf8' })
  rmSync(dir, { recursive: true, force: true })
  return { status: result.status, stderr: result.stderr }
}

test('passes when the license texts and notices are present', () => {
  assert.equal(check(() => {}).status, 0)
})

test('fails when any license file is missing, altered or incomplete', () => {
  const cases: [string, (dir: string) => void, RegExp][] = [
    ['missing MIT', dir => rmSync(join(dir, 'LICENSE-MIT')), /LICENSE-MIT/],
    ['missing Apache', dir => rmSync(join(dir, 'LICENSE-APACHE')), /LICENSE-APACHE/],
    ['altered Apache', dir => appendFileSync(join(dir, 'LICENSE-APACHE'), 'x'), /LICENSE-APACHE/],
    ['missing notice', dir => rmSync(join(dir, 'THIRD-PARTY-NOTICES.txt')), /THIRD-PARTY-NOTICES/],
    ['no copyright', dir => writeFileSync(join(dir, 'THIRD-PARTY-NOTICES.txt'), notice.split('\n').slice(1).join('\n')), /copyright/],
    ['no crates', dir => writeFileSync(join(dir, 'THIRD-PARTY-NOTICES.txt'), notice.replace('Rust crates (2)', 'Rust crates (0)')), /Rust crates/],
    ['no npm', dir => writeFileSync(join(dir, 'THIRD-PARTY-NOTICES.txt'), notice.replace(/^npm.*$/m, '')), /npm packages/],
  ]
  for (const [name, change, message] of cases) {
    const result = check(change)
    assert.equal(result.status, 1, name)
    assert.match(result.stderr, message, name)
  }
})
