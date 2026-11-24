// #890: error codes and limits that server, client-core and web each spell as literals must agree.
// Test-only source scan; the wire format stays as is. Each side is read as follows:
// server: literals non-test Rust under server/src emits as a code, i.e. right after a `StatusCode::X,`
// (ApiError and per-module error mappings) or as the code of a WebSocket `Self::error(socket, channel, ..)`;
// test modules and their files are removed;
// core: literals client-core/src compares against (`== "x"`, `Some("x")`, match arms);
// web: literals web/src compares an `error`/`code` against (`=== 'x'`, `!== 'x'`, `switch` cases);
// limits: one capture per validator or constant, and maxLength in openapi.json.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Repo = { files: Record<string, string>, openapi: unknown }

// Every server error code that client-core or web matches on, and which client sides match it.
export const sharedCodes: Record<string, ('core' | 'web')[]> = {
  channel_archived: ['web'],
  channel_grant_not_found: ['web'],
  channel_manager_guest: ['web'],
  channel_manager_private_only: ['web'],
  'channel name already exists': ['web'],
  'channel not found': ['web'],
  channel_not_found: ['core', 'web'],
  chain_too_large: ['web'],
  current_password_incorrect: ['web'],
  dm_channel_fixed: ['web'],
  dm_peer_access_lapsed: ['web'],
  dm_peer_deactivated: ['web'],
  dm_topics_not_allowed: ['web'],
  forbidden: ['web'],
  history_generation_changed: ['core', 'web'],
  invalid_cursor: ['web'],
  invalid_new_password: ['web'],
  invalid_section_name: ['web'],
  invalid_section_order: ['web'],
  invite_account_mismatch: ['web'],
  invite_issuer_unauthorized: ['web'],
  invite_limit_reached: ['web'],
  invite_sign_in_required: ['web'],
  invite_unavailable: ['web'],
  last_channel_grant: ['web'],
  last_channel_manager: ['web'],
  last_owner: ['web'],
  lock_contention: ['web'],
  member_already_active: ['web'],
  member_not_found: ['web'],
  operation_conflict: ['web'],
  organization_unavailable: ['web'],
  reply_chain_not_found: ['web'],
  search_query_too_short: ['web'],
  search_timeout: ['web'],
  search_unavailable: ['web'],
  section_deleted: ['web'],
  section_id_conflict: ['web'],
  section_layout_changed: ['web'],
  section_limit: ['web'],
  section_not_found: ['web'],
  snapshot_expired: ['core', 'web'],
  subscription_limit: ['core', 'web'],
  topic_not_found: ['web'],
  version_conflict: ['web'],
}

// Values web compares an `error` against that are not server codes.
const webOnlyCodes: Record<string, string> = {
  incorrect: 'account-security.ts SecurityError, mapped from current_password_incorrect',
  invalid: 'account-security.ts SecurityError, mapped from any other 400',
  invalid_new: 'account-security.ts SecurityError, mapped from invalid_new_password',
  throttled: 'account-security.ts SecurityError, mapped from 429',
  unconfirmed: 'account-security.ts SecurityError, set when the confirmation field differs',
}

type Capture = { file: string, pattern: RegExp }
type Limit = {
  server: Capture, openapi: string[],
  web: { file: string, name: string },
}

const textLimits: Record<string, Limit> = {
  'message body': {
    server: { file: 'server/src/messages/send.rs', pattern: /self\.body\.chars\(\)\.count\(\) > (\d+)/g },
    openapi: ['SendMessageRequest/properties/body'],
    web: { file: 'web/src/sync.ts', name: 'MESSAGE_BODY_MAX' },
  },
  'Topic name': {
    server: { file: 'server/src/messages/topics.rs', pattern: /name\.chars\(\)\.count\(\) <= (\d+)/g },
    openapi: ['SendMessageRequest/properties/topic_name', 'MoveChainRequest/allOf/0/properties/topic_name'],
    web: { file: 'web/src/sync.ts', name: 'TOPIC_NAME_MAX' },
  },
  'Channel name': {
    server: { file: 'server/src/channels.rs', pattern: /name\.chars\(\)\.count\(\) > (\d+)/g },
    openapi: ['CreateChannelRequest/properties/name', 'UpdateChannelRequest/oneOf/0/properties/name', 'Channel/properties/name'],
    web: { file: 'web/src/channels.ts', name: 'CHANNEL_NAME_MAX' },
  },
  'Section name': {
    server: { file: 'server/src/channels/sections.rs', pattern: /name\.chars\(\)\.count\(\) > (\d+)/g },
    openapi: ['CreateSection/properties/name', 'RenameSection/properties/name'],
    web: { file: 'web/src/section-ui.ts', name: 'SECTION_NAME_MAX' },
  },
}

const coreLimits = ['MAIN_MESSAGE_LIMIT', 'TOPIC_MESSAGE_LIMIT', 'REPLY_MESSAGE_LIMIT',
  'INACTIVE_CHANNEL_MESSAGE_LIMIT', 'INACTIVE_CHANNEL_LIMIT', 'TOTAL_MESSAGE_LIMIT', 'SYNC_MESSAGE_LIMIT']
const coreFile = 'client-core/src/types.rs'
const webCoreFile = 'web/src/protocol-types.ts'

// Rust source with comments and string contents blanked, plus its string literals.
function lexRust(source: string): { code: string, strings: { value: string, start: number, end: number }[] } {
  let code = ''
  const strings: { value: string, start: number, end: number }[] = []
  let i = 0
  const blank = (from: number, to: number) => { code += source.slice(from, to).replace(/[^\n]/g, ' ') }
  while (i < source.length) {
    const rest = source.slice(i, i + 3)
    const raw = /^b?r(#*)"/.exec(source.slice(i, i + 40))
    if (rest.startsWith('//')) {
      const end = source.indexOf('\n', i)
      const to = end < 0 ? source.length : end
      blank(i, to); i = to
    } else if (rest.startsWith('/*')) {
      let depth = 0, j = i
      do {
        if (source.startsWith('/*', j)) { depth++; j += 2 } else if (source.startsWith('*/', j)) { depth--; j += 2 } else j++
      } while (depth > 0 && j < source.length)
      blank(i, j); i = j
    } else if (raw && !/[\w]/.test(source[i - 1] ?? '')) {
      const close = `"${raw[1]}`
      const end = source.indexOf(close, i + raw[0].length)
      const to = end < 0 ? source.length : end + close.length
      strings.push({ value: source.slice(i + raw[0].length, end), start: i, end: to })
      code += raw[0]; blank(i + raw[0].length, to - close.length); code += close; i = to
    } else if (source[i] === '"') {
      let j = i + 1
      while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1
      strings.push({ value: source.slice(i + 1, j), start: i, end: j + 1 })
      code += '"'; blank(i + 1, j); code += '"'; i = j + 1
    } else if (source[i] === "'") {
      // A char literal ('x', '\n', '\u{..}') is blanked; a lifetime ('a) is code.
      const char = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'])'/u.exec(source.slice(i, i + 12))
      if (char) { blank(i, i + char[0].length); i += char[0].length } else { code += "'"; i++ }
    } else { code += source[i]; i++ }
  }
  return { code, strings }
}

function matchingBrace(code: string, open: number): number {
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return i
  }
  return code.length
}

const testModule = /#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*([{;])/g

function moduleDir(path: string): string {
  return /\/(?:lib|main|mod)\.rs$/.test(path) ? path.replace(/\/[^/]+$/, '') : path.replace(/\.rs$/, '')
}

const lexCache = new Map<string, ReturnType<typeof lexRust>>()

// Non-test Rust files under `root` and the string literals outside `#[cfg(test)] mod` blocks.
function rustProduct(files: Record<string, string>, root: string) {
  const testDirs: string[] = []
  const lexed = new Map<string, ReturnType<typeof lexRust>>()
  for (const [path, source] of Object.entries(files)) {
    if (!path.startsWith(`${root}/`) || !path.endsWith('.rs')) continue
    const lex = lexCache.get(source) ?? lexRust(source)
    lexCache.set(source, lex)
    lexed.set(path, lex)
    for (const match of lex.code.matchAll(testModule)) testDirs.push(`${moduleDir(path)}/${match[1]}`)
  }
  const product = new Map<string, { source: string, strings: { value: string, start: number, end: number }[] }>()
  for (const [path, lex] of lexed) {
    if (testDirs.some(dir => path === `${dir}.rs` || path.startsWith(`${dir}/`))) continue
    const removed: [number, number][] = []
    for (const match of lex.code.matchAll(testModule)) {
      if (match[2] === '{') removed.push([match.index, matchingBrace(lex.code, match.index + match[0].length - 1)])
    }
    const strings = lex.strings.filter(s => !removed.some(([from, to]) => s.start >= from && s.start <= to))
    product.set(path, { source: files[path], strings })
  }
  return product
}

// Codes are lower-case words joined by `_` or, for a few older codes such as `channel not found`, single spaces.
const codeShape = /^[a-z][a-z0-9_]*(?: [a-z0-9_]+)*$/

const emitted = /(?:StatusCode::[A-Z_]+|\bSelf::error\(\s*socket\s*,\s*(?:None|Some\(\w+\)))\s*,\s*$/

export function serverCodes(repo: Repo): Set<string> {
  const codes = new Set<string>()
  for (const { source, strings } of rustProduct(repo.files, 'server/src').values()) {
    for (const { value, start } of strings) {
      if (codeShape.test(value) && emitted.test(source.slice(Math.max(0, start - 80), start))) codes.add(value)
    }
  }
  return codes
}

function coreMatchedCodes(repo: Repo): Set<string> {
  const codes = new Set<string>()
  for (const { source, strings } of rustProduct(repo.files, 'client-core/src').values()) {
    for (const { value, start, end } of strings) {
      const compared = /(?:==|!=|Some\()\s*$/.test(source.slice(Math.max(0, start - 8), start)) ||
        /^\s*(?:=>|\|)/.test(source.slice(end, end + 4))
      if (compared && codeShape.test(value)) codes.add(value)
    }
  }
  return codes
}

const webProduct = (path: string) => /^web\/src\/.*\.(?:ts|svelte)$/.test(path) &&
  !/\.test\.ts$|test-helpers|\.d\.ts$/.test(path)

function webMatchedCodes(repo: Repo): Set<string> {
  const codes = new Set<string>()
  for (const [path, source] of Object.entries(repo.files)) {
    if (!webProduct(path)) continue
    for (const match of source.matchAll(/(?<![\w$])(?:error|code)\s*[!=]==\s*'([a-z][a-z0-9_]*(?: [a-z0-9_]+)*)'/g)) {
      if (!/typeof\s+(?:[\w$]+\??\.)*$/.test(source.slice(Math.max(0, match.index - 60), match.index))) codes.add(match[1])
    }
    for (const match of source.matchAll(/switch\s*\(([^)]*)\)\s*\{/g)) {
      if (!/(?:^|[.\s])(?:error|code)$/.test(match[1].trim())) continue
      const open = match.index + match[0].length - 1
      const body = source.slice(open, matchingBrace(source, open))
      for (const label of body.matchAll(/case\s+'([a-z][a-z0-9_]*(?: [a-z0-9_]+)*)'\s*:/g)) codes.add(label[1])
    }
  }
  return codes
}

function captureOnce(repo: Repo, { file, pattern }: Capture): number {
  const found = [...(repo.files[file] ?? '').matchAll(pattern)]
  assert.equal(found.length, 1, `${file}: ${pattern} must match exactly once`)
  return Number(found[0][1])
}

// `export const NAME = expr` (web) or `pub const NAME: usize = expr;` (core), where expr is
// numbers and earlier constants joined by + and -.
export function constants(source: string, rust: boolean): Map<string, number> {
  const values = new Map<string, number>()
  const declaration = rust ? /pub const (\w+): usize =\s*([^;]+);/g : /export const (\w+) = ([^\n]+)/g
  for (const [, name, expression] of source.matchAll(declaration)) {
    if (!/^[\w\s+-]+$/.test(expression)) continue
    let total = 0
    for (const [, sign, term] of `+${expression.replace(/\s+/g, '')}`.matchAll(/([+-])(\w+)/g)) {
      const value = /^\d+$/.test(term) ? Number(term) : values.get(term)
      if (value === undefined) { total = NaN; break }
      total += sign === '-' ? -value : value
    }
    if (!Number.isNaN(total)) values.set(name, total)
  }
  return values
}

function maxLength(repo: Repo, path: string): unknown {
  let node = (repo.openapi as { components: { schemas: unknown } }).components.schemas
  for (const key of path.split('/')) node = (node as Record<string, unknown> | undefined)?.[key]
  return (node as { maxLength?: unknown } | undefined)?.maxLength
}

// Throws on the first drift; returns the checked pairs.
export function checkContract(repo: Repo): string[] {
  const pairs: string[] = []
  const server = serverCodes(repo), core = coreMatchedCodes(repo), web = webMatchedCodes(repo)
  for (const [code, sides] of Object.entries(sharedCodes)) {
    assert.ok(server.has(code), `error code ${code}: server/src product code never emits "${code}"`)
    for (const [side, matched] of [['core', core], ['web', web]] as const) {
      assert.equal(matched.has(code), sides.includes(side),
        `error code ${code}: ${side} ${matched.has(code) ? 'matches it but the table does not list' : 'no longer matches it but the table lists'} ${side}`)
    }
    pairs.push(`error code ${code}: server = ${sides.join(' = ')}`)
  }
  for (const code of core) assert.ok(code in sharedCodes, `error code ${code}: matched by client-core but not in sharedCodes`)
  for (const code of web) {
    assert.ok(code in sharedCodes || code in webOnlyCodes, `error code ${code}: matched by web but not in sharedCodes or webOnlyCodes`)
  }
  for (const code of Object.keys(webOnlyCodes)) {
    assert.ok(web.has(code), `web-only code ${code}: web no longer matches it; remove it from webOnlyCodes`)
    assert.ok(!server.has(code), `web-only code ${code}: the server also emits it; move it to sharedCodes`)
  }

  for (const [name, limit] of Object.entries(textLimits)) {
    const value = captureOnce(repo, limit.server)
    for (const path of limit.openapi) {
      assert.equal(maxLength(repo, path), value, `${name}: ${limit.server.file} allows ${value}, openapi.json ${path} maxLength differs`)
      pairs.push(`${name} ${value}: ${limit.server.file} = openapi.json ${path}`)
    }
    const webValue = constants(repo.files[limit.web.file] ?? '', false).get(limit.web.name)
    assert.equal(webValue, value, `${name}: ${limit.web.file} ${limit.web.name} differs from the server limit ${value}`)
    pairs.push(`${name} ${value}: openapi.json = ${limit.web.file} ${limit.web.name}`)
  }

  const coreValues = constants(repo.files[coreFile] ?? '', true)
  const webValues = constants(repo.files[webCoreFile] ?? '', false)
  for (const name of coreLimits) {
    assert.ok(coreValues.has(name), `${coreFile} must declare ${name}`)
    assert.equal(webValues.get(name), coreValues.get(name), `${name}: ${webCoreFile} differs from ${coreFile}`)
    pairs.push(`${name} ${coreValues.get(name)}: ${coreFile} = ${webCoreFile}`)
  }
  return pairs
}

export function loadRepo(root: string): Repo {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'server/src', 'client-core/src', 'web/src'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(path => /\.(?:rs|ts|svelte)$/.test(path))
  const files = Object.fromEntries(paths.map(path => [path, readFileSync(resolve(root, path), 'utf8')]))
  return { files, openapi: JSON.parse(readFileSync(resolve(root, 'openapi.json'), 'utf8')) }
}

if (import.meta.main) {
  const pairs = checkContract(loadRepo(fileURLToPath(new URL('../', import.meta.url))))
  console.log(`${pairs.join('\n')}\n${pairs.length} shared contract pairs agree`)
}
