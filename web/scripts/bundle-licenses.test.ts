import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bundlePackages, checkBundlePackages, denyAllowList, licenseAllowed, type BundlePackage } from './bundle-licenses.ts'

const allow = denyAllowList(readFileSync(new URL('../../deny.toml', import.meta.url), 'utf8'))
const pkg = (license: string, texts = [{ file: 'LICENSE', text: 'text' }]): BundlePackage => ({ name: 'p', version: '1.0.0', license, texts })

describe('bundle license allow-list', () => {
  it('reads the allow-list from deny.toml', () => {
    expect(allow).toContain('MIT')
    expect(allow).toContain('Apache-2.0 WITH LLVM-exception')
    expect(() => denyAllowList('[advisories]\nallow = ["MIT"]\n')).toThrow()
  })

  it('evaluates OR, AND, WITH and parentheses', () => {
    for (const ok of ['MIT', '(MIT OR Apache-2.0)', 'MIT OR GPL-3.0-only', 'MIT AND ISC', 'Apache-2.0 WITH LLVM-exception', '(GPL-2.0-only OR (MIT AND Zlib))'])
      expect(licenseAllowed(ok, allow), ok).toBe(true)
    for (const bad of ['GPL-3.0-only', 'MIT AND GPL-3.0-only', 'MIT+', 'GPL-2.0-only WITH Classpath-exception-2.0', 'Apache-2.0 WITH Other'])
      expect(licenseAllowed(bad, allow), bad).toBe(false)
    for (const broken of ['SEE LICENSE IN LICENSE.txt', '(MIT', 'MIT OR', 'AND MIT', ''])
      expect(() => licenseAllowed(broken, allow), broken).toThrow()
  })

  it('fails on a package outside the allow-list, with an unknown license or without a license file', () => {
    expect(() => checkBundlePackages([pkg('MIT'), pkg('(MIT OR Apache-2.0)')], allow)).not.toThrow()
    for (const bad of [pkg('GPL-3.0-only'), pkg(''), pkg('SEE LICENSE IN LICENSE'), pkg('UNLICENSED'), pkg('MIT', [])])
      expect(() => checkBundlePackages([pkg('MIT'), bad], allow)).toThrow(/Bundle license check failed/)
  })
})

describe('bundle package resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'bundle-licenses-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const web = join(root, 'web')
  const write = (dir: string, manifest: object, license = 'LICENSE') => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    if (license) writeFileSync(join(dir, license), `${JSON.stringify(manifest)} license`)
  }
  write(join(web, 'node_modules/a'), { name: 'a', version: '1.0.0', license: 'MIT' })
  write(join(web, 'node_modules/@s/b'), { name: '@s/b', version: '2.0.0', license: 'ISC' }, 'license.md')
  write(join(web, 'node_modules/a/node_modules/c'), { name: 'c', version: '3.0.0', license: 'GPL-3.0-only' })
  write(join(web, 'node_modules/vite'), { name: 'vite', version: '8.0.0', license: 'MIT' })
  const resolve = (name: string) => join(web, 'node_modules', name)

  it('resolves module ids, nested and scoped packages and bundler runtime helpers', () => {
    const packages = bundlePackages([
      join(web, 'src/App.svelte'), join(web, 'node_modules/a/index.js'), join(web, 'node_modules/a/lib/x.js?commonjs'),
      join(web, 'node_modules/@s/b/dist/b.js'), '\0vite/modulepreload-polyfill.js',
    ], web, resolve)
    expect(packages.map(p => `${p.name}@${p.version}:${p.license}:${p.texts.map(t => t.file)}`))
      .toEqual(['@s/b@2.0.0:ISC:license.md', 'a@1.0.0:MIT:LICENSE', 'vite@8.0.0:MIT:LICENSE'])
  })

  it('finds a disallowed package nested under another and rejects unknown origins', () => {
    const packages = bundlePackages([join(web, 'node_modules/a/node_modules/c/index.js')], web, resolve)
    expect(() => checkBundlePackages(packages, allow)).toThrow(/c@3.0.0: license "GPL-3.0-only"/)
    expect(() => bundlePackages(['\0unknown-helper'], web, resolve)).toThrow(/virtual/)
    expect(() => bundlePackages([join(root, 'elsewhere/x.js')], web, resolve)).toThrow(/outside the web app/)
  })
})
