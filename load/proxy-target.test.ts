import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { outsideCheckout, staticConfig, replaceOnce } from './proxy-target.ts';
test('static TLS only removes ACME and keeps production routing, headers and timeouts', () => {
  for (const proxy of ['caddy', 'nginx'] as const) {
    const source = readFileSync(new URL(`../deploy/${proxy === 'caddy' ? 'Caddyfile' : 'nginx.conf'}`, import.meta.url), 'utf8');
    const config = staticConfig(proxy, source);
    assert.ok(config.includes('/measure/key.pem'));
    assert.ok(config.includes('3600s'));
    assert.ok(config.includes('Permissions-Policy'));
    assert.ok(config.includes('app:8080'));
    assert.throws(() => staticConfig(proxy, source + source), /drift/);
    assert.throws(() => staticConfig(proxy, source.replace(proxy === 'caddy' ? '\n{$FUKULOW_DOMAIN:localhost} {' : 'acme_certificate public;', 'changed')), /drift/);
    if (proxy === 'caddy') assert.equal(config.replace('\n\ttls /measure/cert.pem /measure/key.pem', ''), source);
    else {
      assert.ok(config.includes('ssl_reject_handshake on'));
      assert.ok(config.includes('map $request_host $known_host'));
      assert.ok(config.includes('proxy_set_header Upgrade'));
      for (const needle of ['ssl_certificate $acme_certificate;', 'ssl_certificate_key $acme_certificate_key;', 'challenge http-01;'])
        assert.throws(() => staticConfig(proxy, source.replace(needle, 'changed')), /drift/);
    }
  }
});
test('replacement and artifact guards fail closed', () => {
  assert.throws(() => replaceOnce('a a', 'a', 'b'));
  assert.throws(() => replaceOnce('x', 'a', 'b'));
  assert.throws(() => outsideCheckout(process.cwd()));
  assert.throws(() => outsideCheckout(`${process.cwd()}/artifacts`));
  assert.throws(() => outsideCheckout('relative'));
  assert.ok(outsideCheckout('/private/tmp/proxy-test'));
});

test('artifact guard resolves symlinks before allowing an external path', () => {
  const dir = mkdtempSync(`${tmpdir()}/proxy-path-`);
  try {
    symlinkSync(process.cwd(), `${dir}/checkout`, 'dir');
    assert.throws(() => outsideCheckout(`${dir}/checkout/new-artifacts`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
