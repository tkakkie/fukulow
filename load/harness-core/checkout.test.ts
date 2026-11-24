import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { outsideCheckout } from './checkout.ts';
import { external } from '../dms-formal-config.ts';
import { outsideCheckout as dmsWorkload } from '../dms-workload.ts';
import { outsideCheckout as proxyTarget } from '../proxy-target.ts';

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

// Same-input equality against every existing guard, through the wrapper each harness would keep, on
// the inputs where the guards disagree with each other: symlinks either way, a relative path, a missing
// parent and a child whose name starts with "..". Each guard runs from the checkout as harnesses do.
function divergent() {
  const { base, checkout } = layout();
  symlinkSync(join(base, 'out'), join(checkout, 'load/to-out'));
  symlinkSync(join(checkout, 'load'), join(base, 'into-checkout'));
  const inputs = [join(base, 'out/new'), join(checkout, 'load/new'), join(checkout, 'load/to-out/run'), join(base, 'into-checkout/run'),
    '../out/new', 'new', join(base, 'missing/deeper/run'), join(checkout, '..cache/run'), checkout, base, `${checkout}-other/run`];
  return { checkout, inputs };
}
function fromCheckout<T>(checkout: string, run: () => T): T {
  const before = process.cwd();
  try { process.chdir(checkout); return run(); } finally { process.chdir(before); }
}
const accepts = (run: () => unknown) => { try { run(); return true; } catch { return false; } };

test('proxy-target.ts guard: kit resolve mode on the raw path, from the checkout', () => {
  const { checkout, inputs } = divergent();
  fromCheckout(checkout, () => {
    for (const raw of inputs) assert.equal(outsideCheckout(raw, resolve('.')), accepts(() => proxyTarget(raw)), raw);
  });
});

test('dms-workload.ts guard (dms-record, dms-seed, dms-instrument, dms-formal-seed): kit lexical mode after the same resolve()', () => {
  const { checkout, inputs } = divergent();
  fromCheckout(checkout, () => {
    for (const raw of inputs) assert.equal(outsideCheckout(resolve(raw), resolve('.'), 'lexical'), dmsWorkload(resolve(raw), resolve('.')), raw);
    // dms-record.ts resolves LOAD_RESULT_DIR first, so `../out/new` is accepted; skipping that step rejects it.
    assert.equal(outsideCheckout(resolve('../out/new'), resolve('.'), 'lexical'), true);
    assert.equal(outsideCheckout('../out/new', resolve('.'), 'lexical'), false);
  });
});

test('dms-formal-config.ts external: keeps its own realpath step, then kit lexical mode', () => {
  const { checkout, inputs } = divergent();
  const canonical = (path: string) => { if (!isAbsolute(path)) throw new Error('Paths must be absolute'); return existsSync(path) ? realpathSync(path) : resolve(realpathSync(dirname(path)), path.split('/').at(-1)!); };
  const wrapper = (path: string) => { const c = canonical(path); if (!outsideCheckout(c, realpathSync(checkout), 'lexical')) throw new Error('Path must be outside checkout'); return c; };
  for (const raw of inputs) assert.deepEqual(outcome(() => wrapper(raw)), outcome(() => external(raw, checkout)), raw);
  // Without that step a missing parent would be accepted instead of throwing.
  assert.equal(outsideCheckout(inputs[6]!, checkout), true);
  assert.equal(accepts(() => external(inputs[6]!, checkout)), false);
});

test('log-compare/options.ts guard: kit lexical mode against process.cwd()', () => {
  const { checkout, inputs } = divergent();
  fromCheckout(checkout, () => {
    const old = (out: string) => !(out === process.cwd() || out.startsWith(process.cwd() + '/'));
    for (const raw of inputs) assert.equal(outsideCheckout(resolve(raw), process.cwd(), 'lexical'), old(resolve(raw)), raw);
  });
});

test('signin.ts and signin-owner.ts guard: kit lexical mode after resolve(), except a child named "..*", which the kit rejects', () => {
  const { checkout, inputs } = divergent();
  fromCheckout(checkout, () => {
    const old = (raw: string) => { const rel = relative(resolve('.'), resolve(raw)); return !(!rel || (!rel.startsWith('..') && !isAbsolute(rel))); };
    const dotted = join(checkout, '..cache/run');
    for (const raw of inputs.filter(p => p !== dotted)) assert.equal(outsideCheckout(resolve(raw), resolve('.'), 'lexical'), old(raw), raw);
    // The one decision adoption changes: the old guard accepts this path inside the checkout.
    assert.equal(old(dotted), true);
    assert.equal(outsideCheckout(dotted, resolve('.'), 'lexical'), false);
    assert.equal(outsideCheckout(dotted, resolve('.')), false);
  });
});

function outcome(run: () => unknown) { try { return { value: run() }; } catch (error) { return { threw: (error as Error).message }; } }

test('the inputs above are ones where the existing guards disagree, so one mode cannot serve every guard', () => {
  const { checkout, inputs } = divergent();
  fromCheckout(checkout, () => {
    const [, , outward, inward, relativeOut] = inputs as [string, string, string, string, string];
    assert.deepEqual([outward, inward].map(p => [accepts(() => proxyTarget(p)), dmsWorkload(p, resolve('.'))]), [[true, false], [false, true]]);
    assert.deepEqual([accepts(() => proxyTarget(relativeOut)), dmsWorkload(resolve(relativeOut), resolve('.'))], [false, true]);
    assert.deepEqual([outsideCheckout(outward, resolve('.')), outsideCheckout(outward, resolve('.'), 'lexical')], [true, false]);
    assert.deepEqual([outsideCheckout(inward, resolve('.')), outsideCheckout(inward, resolve('.'), 'lexical')], [false, true]);
  });
});
