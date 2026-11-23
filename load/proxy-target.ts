import { randomInt } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Proxy, Tls } from './proxy-judgment.ts';

export const domain = 'fukulow.test';
export function outsideCheckout(path: string) {
  const full = resolve(path);
  let parent = full;
  while (!existsSync(parent)) parent = dirname(parent);
  const canonical = resolve(realpathSync(parent), relative(parent, full));
  const rel = relative(realpathSync('.'), canonical);
  assert.ok(isAbsolute(path) && (rel === '..' || rel.startsWith('../')), 'artifacts and TLS files must be outside the checkout');
  return full;
}
export function replaceOnce(text: string, before: string, after: string): string {
  assert.equal(text.split(before).length, 2, `production config drift: expected exactly one ${JSON.stringify(before)}`);
  return text.replace(before, after);
}
export function staticConfig(proxy: Proxy, source: string) {
  if (proxy === 'caddy') return replaceOnce(source, '\n{$FUKULOW_DOMAIN:localhost} {',
    '\n{$FUKULOW_DOMAIN:localhost} {\n\ttls /measure/cert.pem /measure/key.pem');
  let config = replaceOnce(source, `    acme_issuer public {
        uri https://acme-v02.api.letsencrypt.org/directory;
        challenge http-01;
        state_path /var/lib/nginx/acme;
        accept_terms_of_service;
    }\n`, '');
  config = replaceOnce(config, '        acme_certificate public;\n', '');
  config = replaceOnce(config, 'ssl_certificate $acme_certificate;', 'ssl_certificate /measure/cert.pem;');
  return replaceOnce(config, 'ssl_certificate_key $acme_certificate_key;', 'ssl_certificate_key /measure/key.pem;');
}
// One leaf/key is shared by every proxy/run in a comparison. No key contents enter JS or artifacts.
export function createCertificate(): string {
  const dir = mkdtempSync(`${tmpdir()}/fukulow-proxy-tls-`);
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  try {
    openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ca.key');
    openssl('req', '-new', '-x509', '-key', 'ca.key', '-sha256', '-days', '2', '-subj', '/CN=Disposable measurement CA', '-out', 'ca.pem');
    openssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'key.pem');
    openssl('req', '-new', '-key', 'key.pem', '-subj', `/CN=${domain}`, '-out', 'leaf.csr');
    writeFileSync(`${dir}/extensions`, `subjectAltName=DNS:${domain}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n`);
    openssl('x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '2', '-sha256', '-extfile', 'extensions', '-out', 'cert.pem');
    chmodSync(`${dir}/ca.key`, 0o600);
    // nginx's production entrypoint runs as nginx; the private 0700 parent and read-only
    // per-file Docker mounts restrict the shared fixture to this run's containers.
    chmodSync(`${dir}/key.pem`, 0o644);
    return dir;
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
}
export function proxyOverride(proxy: Proxy, directory: string, port: string) {
  outsideCheckout(directory);
  const production = readFileSync('compose.yml', 'utf8');
  const image = production.match(new RegExp(`  ${proxy}:\\n[\\s\\S]*?    image: (\\S+)`))?.[1];
  assert.match(image ?? '', /@sha256:[a-f0-9]{64}$/);
  const source = readFileSync(`deploy/${proxy === 'caddy' ? 'Caddyfile' : 'nginx.conf'}`, 'utf8');
  const config = `${directory}/${proxy}.conf`;
  writeFileSync(config, staticConfig(proxy, source));
  const entrypoint = proxy === 'nginx' ? `
    entrypoint: ["/bin/bash", "/etc/nginx/acme-entrypoint.sh"]` : '';
  const mounts = proxy === 'nginx' ? `
      - ${resolve('deploy/nginx-acme.sh')}:/etc/nginx/acme-entrypoint.sh:ro
      - ${config}:/etc/nginx/templates/nginx.conf.template:ro` : `
      - ${config}:/etc/caddy/Caddyfile:ro`;
  const prefix = `10.${randomInt(180, 250)}.${randomInt(256)}`;
  const yaml = `services:
  app:
    environment:
      FUKULOW_COOKIE_SECURE: "true"
      FUKULOW_TRUSTED_PROXIES: ${prefix}.2
      FUKULOW_CLIENT_IP_HEADER: x-forwarded-for
    networks:
      default:
        ipv4_address: ${prefix}.3
  proxy:
    image: ${image}${entrypoint}
    environment:
      FUKULOW_DOMAIN: ${domain}
      NGINX_ACME_PACKAGE_VERSION: 1.31.9+0.4.2-1~trixie
    ulimits:
      nofile: 65536
    depends_on: [app]
    ports: ["127.0.0.1:${port}:443"]
    networks:
      default:
        ipv4_address: ${prefix}.2
        aliases: [${domain}]
    volumes:${mounts}
      - ${directory}/cert.pem:/measure/cert.pem:ro
      - ${directory}/key.pem:/measure/key.pem:ro
networks:
  default:
    ipam:
      config:
        - subnet: ${prefix}.0/24
          gateway: ${prefix}.1
          ip_range: ${prefix}.128/25
`;
  const path = `${directory}/override.yml`;
  writeFileSync(path, yaml);
  return path;
}
export function recordTls(network: string, run: (...args: string[]) => string): Tls[] {
  const nodeImage = readFileSync('Dockerfile', 'utf8').match(/^FROM (node:\S+) AS web$/m)?.[1];
  assert.match(nodeImage ?? '', /^node:\d+\.\d+\.\d+-slim@sha256:[a-f0-9]{64}$/);
  assert.ok(nodeImage);
  // Probe both actual client offers from the generator's network. Only startup
  // ECONNREFUSED is polled; TLS failures and missing ALPN fail immediately.
  const script = `const tls=require('node:tls');
    async function probe(ALPNProtocols) {
      const deadline=Date.now()+30000;
      for (;;) { try { return await new Promise((resolve,reject)=> {
        const s=tls.connect({host:'${domain}',port:443,servername:'${domain}',rejectUnauthorized:false,ALPNProtocols,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',ciphers:'TLS_AES_128_GCM_SHA256'},()=>{
          const row={protocol:s.getProtocol(),cipher:s.getCipher().standardName,alpn:s.alpnProtocol};
          s.end();resolve(row);
        });s.setTimeout(5000,()=>s.destroy(new Error('TLS timeout')));s.on('error',reject);
      }); } catch(e) { if(e.code!=='ECONNREFUSED'||Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,100)); } }
    }
    Promise.all([probe(['http/1.1']),probe(['h2','http/1.1'])]).then(r=>console.log(JSON.stringify(r))).catch(()=>process.exit(1));`;
  return JSON.parse(run('run', '--rm', '--network', network, nodeImage, 'node', '-e', script));
}
