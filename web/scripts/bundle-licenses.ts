// #807: the npm packages whose code is in the shipped bundle, resolved from the bundler's module graph,
// checked against deny.toml's license allow-list and written with their license texts for the third-party notice.
import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export type BundlePackage = { name: string, version: string, license: string, texts: { file: string, text: string }[] }

// Bundler runtime helpers that appear as virtual modules, mapped to the package that ships their code.
const VIRTUAL_PACKAGES: [string, string][] = [['\0vite/', 'vite'], ['\0rolldown/', 'rolldown']]
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i
const NOTICE_FILE = /^notice([.-].*)?$/i

// A LICENSE or COPYING file with content; NOTICE files are kept in the notice as supplements but never count as the license.
function isLicenseText(text: { file: string, text: string }): boolean {
  return !NOTICE_FILE.test(text.file) && text.text.trim() !== ''
}

// deny.toml is the single allow-list (#807): its [licenses] allow array.
export function denyAllowList(denyToml: string): string[] {
  const section = denyToml.split(/^\[licenses\]$/m)[1]?.split(/^\[/m)[0]
  const allow = section?.match(/^allow = \[([^\]]*)\]/m)?.[1]
  if (!allow) throw new Error('deny.toml must have a [licenses] allow array')
  const list = [...allow.matchAll(/"([^"]+)"/g)].map(match => match[1])
  if (!list.length) throw new Error('deny.toml [licenses] allow must not be empty')
  return list
}

// A small SPDX expression check: OR needs one allowed side, AND needs both, `X WITH Y` must be listed as a whole.
export function licenseAllowed(expression: string, allow: readonly string[]): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? []
  let at = 0
  const fail = (): never => { throw new Error(`unparsable SPDX expression "${expression}"`) }
  const term = (): boolean => {
    const token = tokens[at++] ?? fail()
    if (token === '(') {
      const value = or()
      if (tokens[at++] !== ')') fail()
      return value
    }
    if (token === ')' || /^(AND|OR|WITH)$/.test(token)) fail()
    if (tokens[at] === 'WITH') {
      at++
      return allow.includes(`${token} WITH ${tokens[at++] ?? fail()}`)
    }
    return allow.includes(token)
  }
  const and = (): boolean => {
    let value = term()
    while (tokens[at] === 'AND') { at++; value = term() && value }
    return value
  }
  const or = (): boolean => {
    let value = and()
    while (tokens[at] === 'OR') { at++; value = and() || value }
    return value
  }
  const result = or()
  if (at !== tokens.length) fail()
  return result
}

// Package directory for a module id, or undefined for first-party web and contract files.
function packageDirOf(id: string, webRoot: string, resolvePackage: (name: string) => string): string | undefined {
  for (const [prefix, name] of VIRTUAL_PACKAGES) if (id.startsWith(prefix)) return resolvePackage(name)
  if (id.startsWith('\0')) throw new Error(`bundle module ${JSON.stringify(id)} is virtual with no known package`)
  const filename = id.split('?')[0].replaceAll('\\', '/')
  const outside = () => new Error(`bundle module ${id} is outside the web app and node_modules`)
  if (!isAbsolute(filename)) throw outside()
  const path = resolve(filename).replaceAll('\\', '/')
  const at = path.lastIndexOf('/node_modules/')
  if (at >= 0) {
    const parts = path.slice(at + '/node_modules/'.length).split('/')
    const length = parts[0].startsWith('@') ? 2 : 1
    return path.slice(0, at) + '/node_modules/' + parts.slice(0, length).join('/')
  }
  const firstParty = [webRoot, resolve(webRoot, '../contract')].some(root => {
    const fromRoot = relative(root, path)
    return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
  })
  if (!firstParty) throw outside()
  return undefined
}

function readBundlePackage(dir: string): BundlePackage {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string, version?: string, license?: unknown }
  const at = `npm package in ${dir.split(sep).join('/').split('/node_modules/').at(-1)}`
  if (!manifest.name || !manifest.version) throw new Error(`${at}: package.json lacks name or version`)
  const texts = readdirSync(dir).filter(file => LICENSE_FILE.test(file)).sort()
    .map(file => ({ file, text: readFileSync(join(dir, file), 'utf8') }))
  return { name: manifest.name, version: manifest.version, license: typeof manifest.license === 'string' ? manifest.license : '', texts }
}

// Throws on a package with no license, an expression outside the allow-list or no non-empty LICENSE/COPYING file.
export function checkBundlePackages(packages: readonly BundlePackage[], allow: readonly string[]): void {
  const errors: string[] = []
  for (const pkg of packages) {
    const at = `${pkg.name}@${pkg.version}`
    if (!pkg.license) errors.push(`${at}: no SPDX license in package.json`)
    else {
      try {
        if (!licenseAllowed(pkg.license, allow)) errors.push(`${at}: license "${pkg.license}" is not in deny.toml [licenses] allow`)
      } catch (error) { errors.push(`${at}: ${(error as Error).message}`) }
    }
    if (!pkg.texts.some(isLicenseText)) errors.push(`${at}: no non-empty LICENSE or COPYING file to include in the third-party notice`)
  }
  if (errors.length) throw new Error(`Bundle license check failed (#807):\n${errors.join('\n')}`)
}

export function bundlePackages(ids: Iterable<string>, webRoot: string, resolvePackage: (name: string) => string): BundlePackage[] {
  const dirs = new Set<string>()
  for (const id of ids) {
    const dir = packageDirOf(id, webRoot, resolvePackage)
    if (dir) dirs.add(dir)
  }
  const byKey = new Map<string, BundlePackage>()
  for (const dir of dirs) {
    const pkg = readBundlePackage(dir)
    byKey.set(`${pkg.name}@${pkg.version}`, pkg)
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}
