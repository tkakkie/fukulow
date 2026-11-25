import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { turbostatArgv } from './frequency-spot-check.ts';

test('turbostat argv has no whitespace inside an element, so sudo-rs can match the scoped sudoers entry', () => {
  for (const arg of turbostatArgv) assert.doesNotMatch(arg, /\s/, arg);
  assert.deepEqual(turbostatArgv.slice(0, 9), ['/usr/bin/systemd-run', '--scope', '--quiet', '--collect', '--slice=-.slice',
    '--unit=fukulow796turbostat.scope', '--property=AllowedCPUs=0-15', '--property=RuntimeMaxSec=150s', '--']);
  assert.deepEqual(turbostatArgv.slice(-2), ['--', '/usr/bin/cat']);
  const readme = readFileSync(new URL('../../harness-core/README.md', import.meta.url), 'utf8');
  assert.equal(/^MEASUREMENT_USER ALL=\(root\) NOPASSWD: (.+)$/m.exec(readme)?.[1].replaceAll('\\,', ','), turbostatArgv.join(' '));
});
