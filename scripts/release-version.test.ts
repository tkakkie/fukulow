import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareVersions, parseTag, planRelease } from './release-version.ts'

test('release tags must be SemVer vX.Y.Z or vX.Y.Z-pre without build metadata', () => {
  for (const tag of ['v0.1.0', 'v1.2.3', 'v10.20.30', 'v1.0.0-rc.1', 'v1.0.0-alpha-1', 'v1.0.0-0.3.7', 'v1.0.0-x.7.z.92']) {
    assert.equal(parseTag(tag).version, tag.slice(1))
  }
  for (const tag of ['1.2.3', 'v1.2', 'v1.2.3.4', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3-', 'v1.2.3-01', 'v1.2.3-rc..1',
    'v1.2.3+build', 'v1.2.3-rc.1+build', 'v1.2.3-ü', 'vlatest', 'v1.2.3 ', `v1.2.3-${'a'.repeat(124)}`, 'v99999999999999999.0.0']) {
    assert.throws(() => parseTag(tag), /release tag/, tag)
  }
})

test('SemVer precedence ranks pre-releases below their release', () => {
  const ordered = ['v1.0.0-alpha', 'v1.0.0-alpha.1', 'v1.0.0-alpha.beta', 'v1.0.0-beta', 'v1.0.0-beta.2', 'v1.0.0-beta.11',
    'v1.0.0-rc.1', 'v1.0.0', 'v1.0.1', 'v1.1.0', 'v2.0.0']
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareVersions(parseTag(ordered[index - 1]), parseTag(ordered[index])), -1, ordered[index])
    assert.equal(compareVersions(parseTag(ordered[index]), parseTag(ordered[index - 1])), 1, ordered[index])
  }
})

test('a release moves X.Y and latest only forward; a pre-release never moves them', () => {
  assert.deepEqual(planRelease('v0.1.0', []), { version: '0.1.0', prerelease: false, tags: ['0.1.0', '0.1', 'latest'], latest: true })
  const existing = ['v0.1.0', 'v0.2.0-rc.1', 'v0.2.0', 'v0.3.0', 'not-a-version', 'v0.3.1-rc.1']
  assert.deepEqual(planRelease('v0.2.1', existing),
    { version: '0.2.1', prerelease: false, tags: ['0.2.1', '0.2'], latest: false, previous: 'v0.2.0' })
  assert.deepEqual(planRelease('v0.3.1', existing),
    { version: '0.3.1', prerelease: false, tags: ['0.3.1', '0.3', 'latest'], latest: true, previous: 'v0.3.0' })
  assert.deepEqual(planRelease('v0.4.0-rc.1', existing),
    { version: '0.4.0-rc.1', prerelease: true, tags: ['0.4.0-rc.1'], latest: false, previous: 'v0.3.1-rc.1' })
  assert.deepEqual(planRelease('v0.1.1', [...existing, 'v0.1.2']).tags, ['0.1.1'])
  // A re-run of the same tag plans the same tags.
  assert.deepEqual(planRelease('v0.3.0', existing).tags, ['0.3.0', '0.3', 'latest'])
})
