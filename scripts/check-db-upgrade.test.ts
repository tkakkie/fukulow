import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cwd } from './compose-test-helpers.ts'

test('upgrade rehearsal pins both old images for the post-merge Compose shape', () => {
  // HEAD is available even in CI's shallow checkout and has the post-merge shape.
  const output = execFileSync(process.execPath, ['scripts/check-db-upgrade.ts', '--check-config'],
    { cwd, env: { PATH: process.env.PATH, CHECK_UPGRADE_REVISION: 'HEAD' }, encoding: 'utf8' })
  assert.match(output, /PASS old stack images: app=.+ migrate=true/)
})
