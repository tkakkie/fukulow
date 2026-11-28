import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { names } from './cluster.ts';
import { options } from './options.ts';
import { sends } from './windows.ts';

test('a W1 sampling failure surfaces as the reason for cancelling the Send child', async t => {
  const out = mkdtempSync(join(tmpdir(), 'd3r-churn-send-test-'));
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
    rmSync(out, {recursive: true});
  });
  const image = 'sha256:' + '0'.repeat(64);
  writeFileSync(join(out, 'docker'), `#!${process.execPath}
switch (process.argv[2]) {
  case 'exec':
    process.stdin.once('data', () => console.log('{}\\nD3R_QUERY_DONE'));
    break;
  case 'create':
    break;
  case 'inspect':
    console.log('${image}');
    break;
  case 'start':
    console.error('LOAD_MEASUREMENT_START');
    setTimeout(() => process.exit(42), 5000);
    break;
  default:
    process.exit(42);
}`, {mode: 0o755});
  process.env.PATH = out + ':' + path;
  const args = options(['--rehearsal', `--out=${out}`, `--app-image=${image}`]);
  await assert.rejects(sends(names(), {pg: image, app: image, k6: image}, args, ''),
    {message: 'Missing sample time or database size'});
});
