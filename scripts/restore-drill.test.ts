import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { postgresImageFromCompose } from './restore-drill.ts'
import { fixture } from './backup-cli-test-helpers.ts'

test('drill reads the pinned Compose database image and follows changes without a second definition', () => {
  const compose = readFileSync(new URL('../compose.yml', import.meta.url), 'utf8')
  const database = compose.match(/^  db:\n((?: {4}[^\n]*\n|\n)*)/m)?.[1]
  assert.ok(database, 'Compose db service must exist')
  const image = database.match(/^    image: (\S+)$/m)?.[1]
  assert.equal(postgresImageFromCompose(), image)
  const changed = image!.replace(/:18(?:\.\d+)?@/, ':18@')
  assert.equal(postgresImageFromCompose(compose.replace(image!, changed)), changed)
})

test('drill rejects missing, interpolated, unpinned, malformed or non-18 database images', () => {
  for (const image of ['postgres:18', 'postgres:18@sha256:bad', '${POSTGRES_IMAGE}',
    postgresImageFromCompose().replace(':18.', ':17.')]) {
    assert.throws(() => postgresImageFromCompose(`services:\n  db:\n    image: ${image}\n`), /literal PostgreSQL 18 tag/)
  }
  assert.throws(() => postgresImageFromCompose('services:\n  app:\n    image: postgres:18\n'), /literal PostgreSQL 18 tag/)
})

for (const failure of ['', 'start', 'list', 'restore', 'sessions', 'integrity', 'cleanup']) {
  test(`restore drill isolates its target and cleans up on ${failure || 'success'}`, t => {
    const { root, run, calls } = fixture(t)
    const archive = join(root, 'backup.dump')
    writeFileSync(archive, 'archive')
    const result = run('./restore-drill.ts', archive, failure)
    assert.equal(result.status, failure ? 1 : 0, result.stderr)
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET_SENTINEL/)
    if (failure) assert.match(result.stderr, new RegExp(`stage=${failure} category=operation`))
    if (failure === 'start') {
      assert.equal(calls().length, 1)
      return
    }
    const commands = calls()
    const create = commands[0]
    const name = create[create.indexOf('--name') + 1]
    assert.match(name, /^fukulow-restore-drill-/)
    assert.ok(create.includes('--tmpfs'))
    assert.equal(create[create.indexOf('--network') + 1], 'none')
    assert.equal(create.at(-1), postgresImageFromCompose())
    assert.ok(!create.some(arg => ['-p', '--publish', '-v', '--volume'].includes(arg)))
    assert.ok(commands.slice(1, -1).every(args => args[0] === 'exec' && args[2] === name))
    assert.deepEqual(commands.at(-1), ['rm', '-f', '-v', name])
    assert.equal(readFileSync(archive, 'utf8'), 'archive')
  })
}
