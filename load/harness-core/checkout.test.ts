import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { outsideCheckout } from './checkout.ts';

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harness-checkout-')));
  const checkout = join(base, 'repo');
  mkdirSync(join(checkout, 'load'), { recursive: true });
  mkdirSync(join(base, 'out'));
  return { base, checkout };
}

test('the checkout and paths under it are inside; siblings, prefixes and the parent are outside', () => {
  const { base, checkout } = layout();
  assert.equal(outsideCheckout(checkout, checkout), false);
  assert.equal(outsideCheckout(join(checkout, 'load'), checkout), false);
  assert.equal(outsideCheckout(join(checkout, 'new/deeper'), checkout), false);
  assert.equal(outsideCheckout(join(checkout, '..repo-artifacts'), checkout), false);
  assert.equal(outsideCheckout(join(base, 'out'), checkout), true);
  assert.equal(outsideCheckout(`${checkout}-other/out`, checkout), true);
  assert.equal(outsideCheckout(base, checkout), true);
  assert.equal(outsideCheckout(join(checkout, '../out'), checkout), true);
});

test('a relative path is never outside the checkout', () => {
  const { checkout } = layout();
  assert.equal(outsideCheckout('out', checkout), false);
  assert.equal(outsideCheckout('../out', checkout), false);
});

test('symlinks resolve on both sides, including through a not-yet-created directory', () => {
  const { base, checkout } = layout();
  symlinkSync(join(checkout, 'load'), join(base, 'into-checkout'));
  symlinkSync(join(base, 'out'), join(checkout, 'load/to-out'));
  symlinkSync(checkout, join(base, 'checkout-link'));
  assert.equal(outsideCheckout(join(base, 'into-checkout/new-artifacts'), checkout), false);
  assert.equal(outsideCheckout(join(checkout, 'load/to-out/run'), checkout), true);
  assert.equal(outsideCheckout(join(checkout, 'load'), join(base, 'checkout-link')), false);
  assert.equal(outsideCheckout(join(base, 'out'), join(base, 'checkout-link')), true);
});

test('the result matches the string comparison harnesses use today when no symlink is involved', () => {
  const { base, checkout } = layout();
  const stringForm = (output: string) => output !== checkout && !output.startsWith(checkout + '/');
  for (const output of [checkout, join(checkout, 'x'), join(checkout, 'x/y'), `${checkout}-other`, join(base, 'out'), base, '/'])
    assert.equal(outsideCheckout(output, checkout), stringForm(output), output);
});
