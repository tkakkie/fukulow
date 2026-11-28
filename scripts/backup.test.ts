import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fixture } from './backup-cli-test-helpers.ts'

test('backup from another directory uses the repository Compose file and publishes a private verified archive', t => {
  const { root, run, calls } = fixture(t)
  const directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, 'previous.dump'), 'previous', { mode: 0o600 })
  writeFileSync(join(root, 'compose.yml'), 'invalid caller Compose file')
  const result = run('./backup.ts', directory)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'Backup passed.')
  const artifact = join(directory, readdirSync(directory).find(name => name.startsWith('fukulow-'))!)
  assert.match(artifact, /fukulow-.*\.dump$/)
  assert.equal(statSync(artifact).mode & 0o777, 0o600)
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  assert.equal(readFileSync(artifact, 'utf8'), 'archive-data')
  assert.equal(readFileSync(join(directory, 'previous.dump'), 'utf8'), 'previous')
  assert.equal(readdirSync(directory).length, 2)
  assert.deepEqual(calls().map(args => args.at(-1)), ['--version', '--format=custom', '--list'])
})

for (const failure of ['version', 'dump', 'signal', 'list']) {
  test(`backup ${failure} failure never publishes partial data or leaks diagnostics`, t => {
    const { root, run } = fixture(t)
    const directory = join(root, 'backups')
    mkdirSync(directory, { mode: 0o700 })
    writeFileSync(join(directory, 'previous.dump'), 'previous')
    const result = run('./backup.ts', directory, failure)
    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET_SENTINEL/)
    assert.match(result.stderr, new RegExp(`stage=${failure === 'signal' ? 'dump' : failure} category=operation`))
    assert.ok(!result.stdout.includes(directory) && !result.stderr.includes(directory))
    assert.deepEqual(readdirSync(directory), ['previous.dump'])
    assert.equal(readFileSync(join(directory, 'previous.dump'), 'utf8'), 'previous')
  })
}

test('backup refuses permissive directories and symlinks', t => {
  const { root, run } = fixture(t)
  const directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  chmodSync(directory, 0o755)
  assert.equal(run('./backup.ts', directory).status, 1)
  chmodSync(directory, 0o700)
  const link = join(root, 'link')
  symlinkSync(directory, link)
  assert.equal(run('./backup.ts', link).status, 1)
  assert.deepEqual(readdirSync(directory), [])
})

test('directory fsync follows rename and its failure preserves previous and newly renamed archives', t => {
  const { root, run } = fixture(t), directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, 'previous.dump'), 'previous')
  const script = join(root, 'sync-test.ts')
  writeFileSync(script, `import { backup } from ${JSON.stringify(new URL('./backup.ts', import.meta.url).href)};
import { readdirSync } from 'node:fs';
import { diagnostic } from ${JSON.stringify(new URL('./backup-safety.ts', import.meta.url).href)};
try { backup(process.argv[2], undefined, { syncDirectory: directory => {
  if (!readdirSync(directory).some(name => name.startsWith('fukulow-') && name.endsWith('.dump'))) throw new Error('rename must precede sync');
  throw Object.assign(new Error('SECRET_SENTINEL'), {code:'EIO'});
} }); process.exitCode=2; } catch (error) { console.error(diagnostic(error)); process.exitCode=1; }
`)
  const result = run(script, directory)
  assert.equal(result.status, 1)
  assert.equal(result.stderr.trim(), 'stage=directory-sync category=io')
  assert.equal(readFileSync(join(directory, 'previous.dump'), 'utf8'), 'previous')
  const final = readdirSync(directory).filter(name => name.startsWith('fukulow-'))
  assert.equal(final.length, 1)
  assert.equal(readFileSync(join(directory, final[0]), 'utf8'), 'archive-data')
  assert.ok(!readdirSync(directory).some(name => name.startsWith('.partial-')))
})

test('backup sweeps crash remnants after locking and refuses an overlapping or stale owner', t => {
  const { root, run } = fixture(t), directory = join(root, 'backups')
  mkdirSync(directory, { mode: 0o700 })
  const partial = join(directory, '.partial-Ab1234')
  mkdirSync(partial, { mode: 0o700 }); writeFileSync(join(partial, 'archive'), 'incomplete')
  writeFileSync(join(directory, '.backup-run.lock'), '', { mode: 0o600 })
  const refused = run('./backup.ts', directory)
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /stage=lock category=busy/)
  assert.equal(readFileSync(join(partial, 'archive'), 'utf8'), 'incomplete')
  rmSync(join(directory, '.backup-run.lock'))
  assert.equal(run('./backup.ts', directory).status, 0)
  assert.ok(!readdirSync(directory).includes('.partial-Ab1234'))
})
