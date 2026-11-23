// #807: render THIRD-PARTY-NOTICES.txt from cargo-about's JSON (Rust crates) and the web build's bundle-licenses.json
// (npm packages in the bundle), after checking that it covers every shipped crate and bundled package.
// Usage: node scripts/third-party-notices.ts <cargo-about.json> <bundle-licenses.json> <shipped-crates.txt> <out>
import { readFileSync, writeFileSync } from 'node:fs'

export type AboutJson = {
  crates: { package: { name: string, version: string }, license: string }[],
  licenses: { id: string, name: string, text: string, used_by: { crate: { name: string, version: string } }[] }[],
}
export type NpmPackage = { name: string, version: string, license: string, texts: { file: string, text: string }[] }

const OWN_CRATE = /^fukulow(-|$)/
const NOTICE_FILE = /^notice([.-].*)?$/i
const blank = (text: string) => text.trim() === ''

// `cargo tree --prefix none -f '{p}'` lines: "name vX.Y.Z", optionally followed by "(...)" markers.
export function parseShipped(tree: string): string[] {
  const crates = new Set<string>()
  for (const line of tree.split('\n')) {
    const match = line.trim().match(/^(\S+) v(\S+)/)
    if (match && !OWN_CRATE.test(match[1])) crates.add(`${match[1]} ${match[2]}`)
  }
  return [...crates].sort()
}

// Every shipped crate must appear in the notice with at least one non-blank license text; every npm package needs its
// own non-empty LICENSE or COPYING text (a NOTICE file is a supplement, not the license).
export function checkCompleteness(about: AboutJson, npm: readonly NpmPackage[], shipped: readonly string[]): string[] {
  const listed = new Set(about.crates.map(c => `${c.package.name} ${c.package.version}`))
  const withText = new Set(about.licenses.filter(l => !blank(l.text)).flatMap(l => l.used_by.map(u => `${u.crate.name} ${u.crate.version}`)))
  const errors: string[] = []
  for (const license of about.licenses) if (blank(license.text)) errors.push(`license text for ${license.id} is blank`)
  if (!shipped.length) errors.push('the shipped crate list is empty')
  for (const crate of shipped) {
    if (!listed.has(crate)) errors.push(`shipped crate ${crate} is missing from the cargo-about output`)
    else if (!withText.has(crate)) errors.push(`shipped crate ${crate} has no license text`)
  }
  if (!npm.length) errors.push('the bundle package list is empty')
  for (const pkg of npm) {
    if (!pkg.license || !pkg.texts.some(t => !NOTICE_FILE.test(t.file) && !blank(t.text)))
      errors.push(`npm package ${pkg.name}@${pkg.version} has no license or license text`)
  }
  return errors
}

export function renderNotices(about: AboutJson, npm: readonly NpmPackage[]): string {
  const crates = about.crates.filter(c => !OWN_CRATE.test(c.package.name))
    .map(c => `${c.package.name} ${c.package.version}  (${c.license})`).sort()
  const out = [
    'fukulow third-party notices',
    'Generated at image build time by scripts/third-party-notices.ts from cargo-about (Rust crates of the server',
    'binary and the browser wasm core) and the web bundle module graph (npm packages). Do not edit by hand.',
    '',
    'fukulow itself: Copyright (c) 2026 tkakkie and the fukulow contributors.',
    'Licensed under the MIT License or the Apache License 2.0, at your option: LICENSE-MIT, LICENSE-APACHE.',
    '',
    'Fonts and images: none from third parties are shipped. The UI names Inter and system fonts in its CSS font',
    'stack; they are not bundled. The owl logo and icons are original fukulow work under the project license.',
    '',
    `Rust crates (${crates.length}):`, ...crates.map(line => `  ${line}`),
    '',
    `npm packages in the web bundle (${npm.length}):`, ...npm.map(p => `  ${p.name} ${p.version}  (${p.license})`),
    '',
  ]
  for (const license of [...about.licenses].sort((a, b) => a.id.localeCompare(b.id))) {
    const users = license.used_by.map(u => `${u.crate.name} ${u.crate.version}`).sort()
    out.push('='.repeat(78), `${license.name} (${license.id})`, `Used by: ${users.join(', ')}`, '-'.repeat(78), license.text.trimEnd(), '')
  }
  for (const pkg of npm) {
    for (const text of pkg.texts) {
      out.push('='.repeat(78), `npm ${pkg.name} ${pkg.version} (${pkg.license}): ${text.file}`, '-'.repeat(78), text.text.trimEnd(), '')
    }
  }
  return out.join('\n')
}

if (import.meta.main) {
  const [aboutPath, npmPath, shippedPath, outPath] = process.argv.slice(2)
  if (!outPath) throw new Error('usage: third-party-notices.ts <cargo-about.json> <bundle-licenses.json> <shipped-crates.txt> <out>')
  const about = JSON.parse(readFileSync(aboutPath, 'utf8')) as AboutJson
  const npm = JSON.parse(readFileSync(npmPath, 'utf8')) as NpmPackage[]
  const shipped = parseShipped(readFileSync(shippedPath, 'utf8'))
  const errors = checkCompleteness(about, npm, shipped)
  if (errors.length) throw new Error(`Third-party notice is incomplete (#807):\n${errors.join('\n')}`)
  writeFileSync(outPath, renderNotices(about, npm))
  const licenses = [...new Set(npm.map(p => p.license))].join(', ')
  const listed = about.crates.filter(c => !OWN_CRATE.test(c.package.name)).length
  console.log(`third-party notices: ${shipped.length}/${shipped.length} shipped Rust crates covered (${listed} listed, ${about.licenses.length} license texts); ${npm.length} bundled npm packages (${licenses})`)
}
