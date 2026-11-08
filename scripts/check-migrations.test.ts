import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./check-migrations.sh', import.meta.url))

test('migration guard compares committed trees and only permits additions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-migrations-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Migration guard test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Migration guard test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const commit = () => {
    git('add', '--all')
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Test fixture')
    return git('rev-parse', 'HEAD')
  }
  const check = (base: string) => spawnSync('bash', [script, base], {
    cwd: directory, encoding: 'utf8',
  })
  git('init', '--quiet')
  mkdirSync(join(directory, 'server/migrations'), { recursive: true })
  // Spaces and newlines must not hide a changed path from the guard.
  const migration = 'server/migrations/001 existing\nname.sql'
  writeFileSync(join(directory, migration), 'SELECT 1;\n')
  const base = commit()

  for (const change of ['unchanged', 'addition', 'unrelated', 'modified', 'deleted', 'renamed', 'moved outside', 'type changed']) {
    await t.test(change, () => {
      git('reset', '--hard', base)
      git('clean', '-fd')
      switch (change) {
        case 'addition':
          writeFileSync(join(directory, 'server/migrations/002.sql'), 'SELECT 2;\n')
          break
        case 'unrelated':
          writeFileSync(join(directory, 'unrelated.txt'), 'outside migrations\n')
          break
        case 'modified':
          writeFileSync(join(directory, migration), 'SELECT 2;\n')
          break
        case 'deleted':
          rmSync(join(directory, migration))
          break
        case 'renamed':
          renameSync(join(directory, migration), join(directory, 'server/migrations/renamed.sql'))
          break
        case 'moved outside':
          renameSync(join(directory, migration), join(directory, 'moved.sql'))
          break
        case 'type changed':
          rmSync(join(directory, migration))
          symlinkSync('002.sql', join(directory, migration))
          break
      }
      commit()
      const result = check(base)
      const allowed = ['unchanged', 'addition', 'unrelated'].includes(change)
      assert.equal(result.status, allowed ? 0 : 1, result.stderr)
      if (!allowed) assert.match(result.stderr, /Existing migrations are append-only/)
    })
  }

  await t.test('main push compares with previous commit', () => {
    git('reset', '--hard', base)
    git('clean', '-fd')
    writeFileSync(join(directory, 'server/migrations/002.sql'), 'SELECT 2;\n')
    const previous = commit()
    writeFileSync(join(directory, 'server/migrations/002.sql'), 'SELECT 3;\n')
    commit()
    assert.equal(check(base).status, 0)
    assert.equal(check(previous).status, 1)
  })

  await t.test('missing base fails closed', () => {
    assert.notEqual(check('0000000000000000000000000000000000000000').status, 0)
  })
})
