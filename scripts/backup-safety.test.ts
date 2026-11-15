import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { acquireLocalLock, assertLocalLock, diagnostic, SafeFailure, safeFailure, stages, sweepPartials } from './backup-safety.ts'

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'backup-safety-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('partial sweep removes only owned private exact generated directories under the exclusive lock', t => {
  const root = fixture(t), outside = fixture(t)
  writeFileSync(join(outside, 'keep'), 'preserve')
  for (const name of ['.partial-aB0123', '.partial-age-Z012xy']) {
    mkdirSync(join(root, name), { mode: 0o700 })
    symlinkSync(outside, join(root, name, 'external'))
  }
  for (const name of ['.partial-unknown', '.partial-age-too-long', 'fukulow-finished.dump']) mkdirSync(join(root, name), { mode: 0o700 })
  mkdirSync(join(root, '.partial-ABCDEF'), { mode: 0o755 })
  writeFileSync(join(root, '.partial-123456'), 'preserve')
  symlinkSync(outside, join(root, '.partial-zyxwvu'))
  const release = acquireLocalLock(root)
  sweepPartials(root); release()
  assert.deepEqual(readdirSync(root).sort(), ['.partial-123456', '.partial-ABCDEF', '.partial-zyxwvu', '.partial-age-too-long', '.partial-unknown', 'fukulow-finished.dump'].sort())
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'preserve')
})

test('local lock refuses concurrent processes and never automatically reaps stale locks', t => {
  const root = fixture(t), release = acquireLocalLock(root)
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquireLocalLock } from ${JSON.stringify(new URL('./backup-safety.ts', import.meta.url).href)};
    try { acquireLocalLock(process.argv[1]); process.exitCode = 2 }
    catch (error) { process.exitCode = error.code === 'EEXIST' ? 0 : 3 }
  `, root], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  release()
  assert.throws(() => assertLocalLock(root, release), /stage=lock category=busy/)
  assert.throws(() => assertLocalLock(root, () => {}), /stage=lock category=busy/)
  closeSync(openSync(join(root, '.backup-run.lock'), 'wx', 0o600))
  assert.throws(() => acquireLocalLock(root), { code: 'EEXIST' })
  assert.deepEqual(readdirSync(root), ['.backup-run.lock'])
})

test('diagnostics allow only fixed stage and error categories and never raw text or code', () => {
  for (const stage of stages) {
    for (const [code, category] of [['EACCES', 'permission'], ['ENOENT', 'missing'], ['ENOSPC', 'space'], ['EIO', 'io'], ['EEXIST', 'busy'], ['PRIVATE_SENTINEL', 'operation']]) {
      const hostile = Object.assign(new Error('PRIVATE_SENTINEL'), { code, path: 'PRIVATE_SENTINEL', cause: 'PRIVATE_SENTINEL' })
      assert.equal(diagnostic(safeFailure(stage, hostile)), `stage=${stage} category=${category}`)
    }
  }
  assert.equal(diagnostic(new Error('PRIVATE_SENTINEL')), 'stage=arguments category=operation')
  const altered = new SafeFailure('dump', 'operation')
  Object.assign(altered, { stage: 'PRIVATE_SENTINEL', category: 'PRIVATE_SENTINEL' })
  assert.equal(diagnostic(altered), 'stage=arguments category=operation')
})
