import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupResources } from './cleanup.ts';
import { resourceNames } from './placement.ts';

const names = resourceNames('test');
const expected = [{kind: 'container', name: names.server}, {kind: 'container', name: names.client},
  {kind: 'volume', name: names.data}, {kind: 'volume', name: names.socket}] as const;

function fake(present: ReadonlyArray<typeof expected[number]>, fail = '') {
  const resources = new Map<string, 'container' | 'volume'>(present.map(({name, kind}) => [name, kind]));
  resources.set('foreign-container', 'container');
  resources.set('foreign-volume', 'volume');
  const removed: string[] = [];
  const docker = (...args: string[]) => {
    if (args[1] === 'ls') return [...resources].filter(([, kind]) => kind === args[0]).map(([name]) => `${name}|`).join('\n');
    const name = args.at(-1)!;
    assert.ok(resources.has(name), name);
    assert.ok(!name.startsWith('foreign-'), name);
    if (name === fail) throw new Error('busy');
    if (args[0] === 'volume') assert.ok(![names.server, names.client].some(name => resources.has(name)));
    resources.delete(name);
    removed.push(name);
    return '';
  };
  return {docker, removed};
}

test('cleanup removes both owned containers before both volumes and verifies their absence', () => {
  const f = fake(expected);
  assert.deepEqual(cleanupResources(f.docker, [...expected]), {verified: true, found: expected, failures: []});
  assert.deepEqual(f.removed, [names.server, names.client, names.data, names.socket]);
});

test('cleanup tolerates a partial start or signal before a client container is created', () => {
  const partial = expected.filter(r => r.name !== names.client);
  const f = fake(partial);
  assert.deepEqual(cleanupResources(f.docker, [...expected]), {verified: true, found: partial, failures: []});
  assert.deepEqual(f.removed, [names.server, names.data, names.socket]);
});

test('cleanup refusal lists a surviving resource even after other removals', () => {
  const f = fake(expected, names.socket);
  const result = cleanupResources(f.docker, [...expected]);
  assert.equal(result.verified, false);
  assert.deepEqual(result.failures, [`volume ${names.socket}: Error: busy`, `still present: volume ${names.socket}`]);
  assert.deepEqual(f.removed, [names.server, names.client, names.data]);
});
