import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectSessionIdentity, readBootId } from './revocation-holds-provenance.ts';

test('SA2 reads the Linux boot ID from procfs and rejects a missing ID', () => {
  const boot = 'e1721ea0-2bb7-4be8-92bf-3dbfdbfd042b';
  assert.equal(readBootId('linux', path => {
    assert.equal(path, '/proc/sys/kernel/random/boot_id');
    return `${boot}\n`;
  }), boot);
  assert.throws(() => readBootId('linux', () => ''), /could not identify.*boot/);
});

test('SA2 reads macOS kern.boottime using the numeric timestamp', () => {
  assert.equal(readBootId('darwin', () => assert.fail('unexpected procfs read'), (program, args) => {
    assert.deepEqual([program, ...args], ['sysctl', '-n', 'kern.boottime']);
    return '{ sec = 1795006085, usec = 465743 } Wed Nov 18 21:48:05 2026\n';
  }), '1795006085.465743');
  assert.throws(() => readBootId('darwin', undefined, () => ''), /could not identify.*boot/);
});

test('SA2 hashes the actual server and helper binaries independently', async t => {
  const checkout = mkdtempSync(join(tmpdir(), 'revocation-provenance-'));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  const binary = join(checkout, 'server'), helperBinary = join(checkout, 'helper');
  writeFileSync(binary, 'server bytes');
  writeFileSync(helperBinary, 'helper bytes');
  const collect = () => collectSessionIdentity({ session: 'test', checkout, binary, helperBinary, sendBuffer: 16_384 },
    (_program, args) => args[0] === 'status' ? '' : 'test-commit\n');
  const current = await collect();
  assert.equal(current.serverSha256, hash('sha256', 'server bytes'));
  assert.equal(current.stallHelperSha256, hash('sha256', 'helper bytes'));
  assert.equal(current.gitClean, true);

  writeFileSync(binary, 'rebuilt server');
  const rebuiltServer = await collect();
  assert.notEqual(rebuiltServer.serverSha256, current.serverSha256);
  assert.equal(rebuiltServer.stallHelperSha256, current.stallHelperSha256);
  writeFileSync(helperBinary, 'rebuilt helper');
  const rebuiltHelper = await collect();
  assert.equal(rebuiltHelper.serverSha256, rebuiltServer.serverSha256);
  assert.notEqual(rebuiltHelper.stallHelperSha256, current.stallHelperSha256);
});

test('SA2 refuses to identify a dirty checkout before reading either binary', async () => {
  for (const dirty of [' M modified.ts\n', '?? untracked.ts\n']) {
    await assert.rejects(collectSessionIdentity({ session: 'test', checkout: 'checkout', binary: 'server', helperBinary: 'helper', sendBuffer: 16_384 },
      (program, args, cwd) => {
        assert.deepEqual([program, ...args], ['git', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
        assert.equal(cwd, 'checkout');
        return dirty;
      }), /SA2:.*clean git working tree/);
  }
});
