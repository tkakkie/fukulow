import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyOrganization, organizationPath } from './compat.ts';

test('baseline compatibility changes only Organization path and identity extraction', () => {
  assert.equal(organizationPath('org', false), '/api/v1/orgs/org');
  assert.equal(organizationPath('org', true), '/api/v1');
  assert.equal(legacyOrganization({ organization: { organization_id: 'org' } }), 'org');
  for (const identity of [null, {}, { organization_id: 1 }]) assert.throws(() => legacyOrganization(identity));
});
