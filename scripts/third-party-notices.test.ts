import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { checkCompleteness, parseShipped, renderNotices, type AboutJson, type NpmPackage } from './third-party-notices.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const list = (source: string, key: string) =>
  [...(source.match(new RegExp(`^${key} = \\[([^\\]]*)\\]`, 'm'))?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(m => m[1])

const about: AboutJson = {
  crates: [
    { package: { name: 'serde', version: '1.0.0' }, license: 'MIT OR Apache-2.0' },
    { package: { name: 'ring', version: '0.17.0' }, license: 'Apache-2.0 AND ISC' },
    { package: { name: 'fukulow-api', version: '0.1.0' }, license: 'MIT OR Apache-2.0' },
  ],
  licenses: [
    { id: 'MIT', name: 'MIT License', text: 'MIT serde text', used_by: [{ crate: { name: 'serde', version: '1.0.0' } }] },
    { id: 'ISC', name: 'ISC License', text: 'ISC ring text', used_by: [{ crate: { name: 'ring', version: '0.17.0' } }] },
  ],
}
const npm: NpmPackage[] = [{ name: 'svelte', version: '5.0.0', license: 'MIT', texts: [{ file: 'LICENSE.md', text: 'svelte text' }] }]
const tree = 'serde v1.0.0\nring v0.17.0 (*)\nfukulow-server v0.1.0 (/app/server)\nserde_derive v1.0.0 (proc-macro)\n\n'

test('about.toml accepts exactly the deny.toml license allow-list', () => {
  const deny = read('deny.toml').split(/^\[licenses\]$/m)[1]
  assert.deepEqual(list(read('about.toml'), 'accepted'), list(deny, 'allow'))
})

test('shipped crates come from cargo tree, without fukulow workspace crates', () => {
  assert.deepEqual(parseShipped(tree), ['ring 0.17.0', 'serde 1.0.0', 'serde_derive 1.0.0'])
})

test('the notice must cover every shipped crate and bundled npm package', () => {
  assert.deepEqual(checkCompleteness(about, npm, ['ring 0.17.0', 'serde 1.0.0']), [])
  assert.match(checkCompleteness(about, npm, parseShipped(tree)).join('\n'), /serde_derive 1.0.0 is missing/)
  const noText = { ...about, licenses: about.licenses.slice(0, 1) }
  assert.match(checkCompleteness(noText, npm, ['ring 0.17.0']).join('\n'), /ring 0.17.0 has no license text/)
  assert.match(checkCompleteness(about, npm, []).join('\n'), /shipped crate list is empty/)
  assert.match(checkCompleteness(about, [], ['serde 1.0.0']).join('\n'), /bundle package list is empty/)
  assert.match(checkCompleteness(about, [{ ...npm[0], texts: [] }], ['serde 1.0.0']).join('\n'), /svelte@5.0.0 has no license/)
})

test('blank Rust license texts and NOTICE-only or blank npm texts fail the completeness check', () => {
  const blankIsc = { ...about, licenses: [about.licenses[0], { ...about.licenses[1], text: ' \n\t ' }] }
  const errors = checkCompleteness(blankIsc, npm, ['ring 0.17.0', 'serde 1.0.0']).join('\n')
  assert.match(errors, /license text for ISC is blank/)
  assert.match(errors, /ring 0.17.0 has no license text/)
  for (const texts of [[{ file: 'NOTICE', text: 'notice' }], [{ file: 'LICENSE', text: '   ' }], [{ file: 'COPYING', text: '' }, { file: 'NOTICE.md', text: 'n' }]])
    assert.match(checkCompleteness(about, [{ ...npm[0], texts }], ['serde 1.0.0']).join('\n'), /svelte@5.0.0 has no license/, JSON.stringify(texts))
  assert.deepEqual(checkCompleteness(about, [{ ...npm[0], texts: [...npm[0].texts, { file: 'NOTICE', text: 'n' }] }], ['serde 1.0.0']), [])
})

test('the rendered notice names the project license and every third-party text', () => {
  const notice = renderNotices(about, npm)
  for (const part of ['tkakkie and the fukulow contributors', 'LICENSE-MIT, LICENSE-APACHE', 'Rust crates (2):',
    'serde 1.0.0  (MIT OR Apache-2.0)', 'MIT serde text', 'ISC ring text', 'npm svelte 5.0.0 (MIT): LICENSE.md', 'svelte text'])
    assert.ok(notice.includes(part), part)
  assert.ok(!notice.includes('fukulow-api 0.1.0'))
})
