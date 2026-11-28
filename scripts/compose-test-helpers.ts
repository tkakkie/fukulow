import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

export const cwd = fileURLToPath(new URL('..', import.meta.url))
export const env = { PATH: process.env.PATH, COMPOSE_PROJECT_NAME: `fukulow-config-${process.pid}`,
  POSTGRES_PASSWORD: 'compose-config-test-only', POSTGRES_APP_PASSWORD: 'app-config-test-only', FUKULOW_SETUP_TOKEN: 'setup-config-test-only', FUKULOW_VERSION: '1.2.3' }
export const args = (profile: string, external = false) => ['compose', '--env-file', '/dev/null', '-f', 'compose.yml',
  ...(external ? ['-f', 'compose.external-db.yml'] : []), '--profile', profile, 'config', '--format', 'json']

export function checkRestrictions(service: Record<string, unknown>) {
  assert.equal(service.read_only, true, 'read_only must be true')
  assert.deepEqual(service.cap_drop, ['ALL'], 'cap_drop must deny ALL')
  assert.deepEqual(service.security_opt, ['no-new-privileges:true'], 'no-new-privileges must be true')
  assert.ok(!service.privileged, 'privileged must be disabled')
  assert.deepEqual(service.cap_add ?? [], [], 'cap_add must stay empty')
  assert.deepEqual(service.volumes ?? [], [], 'no demonstrated writable-path exception')
  assert.deepEqual(service.tmpfs ?? [], [], 'no demonstrated tmpfs exception')
}
