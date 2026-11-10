import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyOrganization, organizationPath, signInPath } from './compat.ts';

test('baseline compatibility preserves old sign-in, Organization paths and identity extraction', () => {
  assert.equal(signInPath(false), '/api/v1/native/session');
  assert.equal(signInPath(true), '/api/v1/session');
  assert.equal(organizationPath('org', false), '/api/v1/orgs/org');
  assert.equal(organizationPath('org', true), '/api/v1');
  assert.equal(legacyOrganization({ organization: { organization_id: 'org' } }), 'org');
  for (const identity of [null, {}, { organization_id: 1 }]) assert.throws(() => legacyOrganization(identity));
});
