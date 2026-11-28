import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseNotes } from './release-notes.ts'

test('release notes list the digests, new migrations, config changes and the rollback limit', () => {
  const index = `sha256:${'1'.repeat(64)}`
  const base = { tag: 'v1.2.3', version: '1.2.3', tags: ['1.2.3', '1.2', 'latest'], index,
    platforms: { amd64: `sha256:${'2'.repeat(64)}`, arm64: `sha256:${'3'.repeat(64)}` }, previous: 'v1.2.2', configChanges: [] }
  const withMigration = releaseNotes({ ...base, migrations: ['server/migrations/202612010000_x.sql'], configChanges: ['.env.example'] })
  assert.match(withMigration, new RegExp(`FUKULOW_VERSION=1\\.2\\.3@${index}`))
  for (const digest of Object.values(base.platforms)) assert.ok(withMigration.includes(digest))
  assert.match(withMigration, /`server\/migrations\/202612010000_x.sql`/)
  assert.match(withMigration, /`\.env\.example`/)
  assert.match(withMigration, /since v1\.2\.2/)
  assert.match(withMigration, /rolling back needs a restore of the pre-upgrade backup/)
  const without = releaseNotes({ ...base, migrations: [] })
  assert.match(without, /adds no migration/)
  assert.doesNotMatch(without, /restore of the pre-upgrade backup/)
})
