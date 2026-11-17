import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export type Entry = {
  component: string, version: string, file: string, pattern: string, support: string,
  updates: string, class: string, cycle?: string, endoflife?: string,
  latest?: { endoflife: string, lts?: boolean } | { github: string },
}

export const requiredComponents = ['Rust', 'Node.js', 'PostgreSQL', 'Debian runtime base', 'Caddy', 'nginx', 'k6',
  'wasm-bindgen-cli', 'Playwright', 'axum', 'tokio', 'sqlx', 'Svelte', 'Vite', 'TypeScript']

// versions.json (#512): every entry names the version pinned in its file; one capture of `pattern` must equal it.
export function checkInventory(entries: Entry[], read: (path: string) => string): void {
  const names = entries.map(entry => entry.component)
  assert.equal(new Set(names).size, names.length, 'inventory components must be unique')
  for (const name of requiredComponents) assert.ok(names.includes(name), `inventory must cover ${name}`)
  for (const entry of entries) {
    const at = `inventory ${entry.component}`
    assert.ok(['dependabot', 'weekly-check', 'manual'].includes(entry.updates), `${at}: unknown updates source`)
    assert.ok(['security', 'patch-minor', 'toolchain', 'major', 'manual-major'].includes(entry.class), `${at}: unknown update class`)
    assert.match(entry.support, /^(latest only|\d{4}-\d{2}-\d{2})$/, `${at}: support must be a date or "latest only"`)
    assert.equal(entry.updates === 'weekly-check', entry.latest !== undefined, `${at}: weekly-check entries, and only they, name a latest source`)
    const found = [...read(entry.file).matchAll(new RegExp(entry.pattern, 'gm'))]
    assert.equal(found.length, 1, `${at}: pattern must match ${entry.file} exactly once`)
    assert.equal(found[0][1], entry.version, `${at}: version must agree with ${entry.file}`)
  }
}

export function checkVersions(files: {
  rust: string, node: string, webNode: string, loadNode: string, dockerfile: string,
  playwright: string, webLock: string, e2e: string,
  compose: string, acme: string, core: string, wasmBuild: string, ci: string,
}): void {
  const rust = files.rust.match(/^channel = "([^"]+)"$/m)?.[1]
  const targets = files.rust.match(/^targets = \[([^\]]*)\]$/m)?.[1]
  assert.ok(targets?.split(',').map(value => value.trim()).includes('"wasm32-unknown-unknown"'),
    'Rust targets must include wasm32-unknown-unknown')
  const node = files.node.trim()
  assert.ok(rust && /^\d+\.\d+\.\d+$/.test(rust), 'Rust must name an exact patch version')
  assert.match(node, /^\d+\.\d+\.\d+$/, 'Node must name an exact patch version')
  for (const [image, version] of [['rust', rust], ['node', node]]) {
    const from = files.dockerfile.split('\n').filter(line => line.startsWith(`FROM ${image}:`))
    assert.equal(from.length, 1, `Dockerfile must have exactly one ${image} base`)
    const reference = from[0].split(/\s+/)[1]
    assert.equal(reference.split('@')[0], `${image}:${version}-slim`, `${image} version must agree with the toolchain`)
    assert.match(reference, /^[^@]+(?:@sha256:[a-f0-9]{64})?$/, `${image} digest must be sha256 with 64 hex digits`)
  }
  assert.equal(files.webNode, node, 'web engines.node must agree with .node-version')
  assert.equal(files.loadNode, node, 'load engines.node must agree with .node-version')
  assert.match(files.playwright, /^\d+\.\d+\.\d+$/, 'Playwright must name an exact patch version')
  const packages = JSON.parse(files.webLock).packages
  assert.equal(packages[''].devDependencies['@playwright/test'], files.playwright, 'Playwright lockfile declaration must agree with package.json')
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    assert.equal(packages[`node_modules/${name}`].version, files.playwright, `${name} lockfile version must agree with package.json`)
  }
  const images = [...files.e2e.matchAll(/^\s+PLAYWRIGHT_IMAGE: (\S+)\s*$/gm)]
  assert.equal(images.length, 1, 'E2E must have exactly one PLAYWRIGHT_IMAGE')
  const playwrightImage = images[0][1]
  assert.equal(playwrightImage.split('@')[0], `mcr.microsoft.com/playwright:v${files.playwright}-noble`, 'Playwright image must agree with package.json and use Noble')
  assert.match(playwrightImage, /^[^@]+@sha256:[a-f0-9]{64}$/, 'Playwright image digest must be sha256 with 64 hex digits')
  const bindgen = files.core.match(/wasm-bindgen = \{ version = "=(\d+\.\d+\.\d+)"/)?.[1]
  assert.ok(bindgen, 'wasm-bindgen must pin an exact version')
  // The image compiles the CLI with --locked; workflows install the checksum-pinned prebuilt release.
  const cliInstalls = [['Dockerfile', files.dockerfile, /cargo install wasm-bindgen-cli --version (\S+) --locked/g],
    ['CI', files.ci, /tool: wasm-bindgen@(\S+?) \}/g], ['E2E', files.e2e, /tool: wasm-bindgen@(\S+?) \}/g]] as const
  for (const [name, source, pattern] of cliInstalls) {
    const installs = [...source.matchAll(pattern)]
    assert.ok(installs.length, name + ' must install a pinned wasm-bindgen CLI')
    for (const install of installs) assert.equal(install[1], bindgen, name + ' wasm-bindgen CLI must agree with crate')
    assert.equal([...source.matchAll(/wasm-bindgen-cli|tool: wasm-bindgen/g)].length, installs.length, name + ' must install wasm-bindgen CLI only in the pinned form')
  }
  assert.match(files.wasmBuild, /cargo.*|run\('cargo'/, 'wasm build uses Cargo')
  assert.match(files.wasmBuild, /'--locked'/, 'wasm build must use --locked')
  const nginxImages = [...files.compose.matchAll(/^\s+image: (nginx:\S+)$/gm)]
  assert.equal(nginxImages.length, 1, 'Compose must have exactly one nginx image')
  const nginx = nginxImages[0][1]
  assert.match(nginx, /^nginx:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/, 'nginx image must pin exact tag and digest')
  const modules = [...files.compose.matchAll(/^\s+NGINX_ACME_PACKAGE_VERSION: (\S+)$/gm)]
  assert.equal(modules.length, 1, 'Compose must have exactly one ACME package version')
  const module = modules[0][1].match(/^(\d+\.\d+\.\d+)\+(\d+\.\d+\.\d+)-\d+~trixie$/)
  assert.ok(module, 'ACME package must pin exact nginx, module and distribution versions')
  assert.equal(`nginx:${module[1]}`, nginx.split('@')[0], 'ACME package nginx ABI version must agree with image')
  assert.match(files.acme, /^export const pebbleImage = 'ghcr\.io\/letsencrypt\/pebble:\d+\.\d+\.\d+@sha256:[a-f0-9]{64}'$/m, 'Pebble must pin exact tag and digest')
}

if (import.meta.main) {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  checkVersions({ rust: read('rust-toolchain.toml'), node: read('.node-version'),
    webNode: JSON.parse(read('web/package.json')).engines.node,
    loadNode: JSON.parse(read('load/package.json')).engines.node, dockerfile: read('Dockerfile'),
    playwright: JSON.parse(read('web/package.json')).devDependencies['@playwright/test'],
    webLock: read('web/package-lock.json'), e2e: read('.github/workflows/e2e.yml'),
    compose: read('compose.yml'), acme: read('scripts/compose-acme.ts'), core: read('client-core/Cargo.toml'), wasmBuild: read('scripts/build-wasm.ts'), ci: read('.github/workflows/ci.yml') })
  checkInventory(JSON.parse(read('versions.json')).entries, read)
}
