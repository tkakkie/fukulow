import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

export const check = <T>(value: T, checks: Record<string, (value: T) => boolean>) =>
  Object.values(checks).every(predicate => predicate(value));
export const fail = (message: string): never => { throw new Error(message); };
export const randomBytes = (length: number) => new ArrayBuffer(length);

const signedOut: string[] = [];
let signIns = 0;
const response = (status: number, body?: unknown) => ({ status, json: () => body });
export default {
  get: () => response(200),
  post: (_url: string, _body: string, params: { tags: { operation: string } }) => {
    switch (params.tags.operation) {
      case 'invite': return response(201, { token: 'invite' });
      case 'accept_invite': return response(200);
      case 'sign_in': return ++signIns === 1
        ? response(200, { token: 'owner', identity: { organizations: [{ organization_id: 'org' }] } })
        : response(200, { token: 'member', identity: { organizations: [] } });
      default: return assert.fail(`Unexpected operation ${params.tags.operation}`);
    }
  },
  del: (_url: string, _body: null, params: { headers: { Authorization: string } }) => {
    signedOut.push(params.headers.Authorization);
    return response(204);
  },
};

test('setup revokes an invited Account Session when its membership check fails', async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      return ['k6', 'k6/crypto', 'k6/http'].includes(specifier)
        ? { url: import.meta.url, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  Object.assign(globalThis, { __ENV: { LOAD_EMAIL: 'owner@example.test', LOAD_PASSWORD: 'fixture' } });
  t.after(() => { Reflect.deleteProperty(globalThis, '__ENV'); });
  const { seed } = await import('./seed.ts');
  assert.throws(() => seed({ channels: 1, subscribers: 1, socketsPerSession: 1, publishMembers: 2,
    visibility: 'public', legacy: false }), { message: 'Invited Account lacks the Organization membership' });
  assert.deepEqual(signedOut, ['Bearer owner', 'Bearer member']);
});
