import type { ObjectInfo } from './backup-r2-model.ts'
import type { Runner } from './backup-r2.ts'

export const runLockKey = 'coordination/run.lock'
interface Element { name: string; text: string; children: Element[] }
function xml(body: Buffer): Element {
  const source = body.toString('utf8').replace(/^<\?xml[^?]*\?>\s*/, '')
  const stack: Element[] = [], roots: Element[] = []
  const decode = (s: string) => s.replace(/&([^;]*);/g, (_match, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (Object.hasOwn(named, entity)) return named[entity]
    const n = /^#\d+$/.test(entity) ? Number(entity.slice(1)) : /^#x[\da-fA-F]+$/.test(entity) ? parseInt(entity.slice(2), 16) : NaN
    if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error('Invalid XML entity')
    return String.fromCodePoint(n)
  })
  const tokens = source.match(/<[^>]*>|[^<]+/g) ?? []
  if (tokens.join('') !== source) throw new Error('Invalid XML')
  for (const token of tokens) {
    if (token.startsWith('</')) {
      const name = /^<\/([A-Za-z][\w]*)\s*>$/.exec(token)?.[1]
      if (!name || stack.pop()?.name !== name) throw new Error('Invalid XML close')
    } else if (token.startsWith('<')) {
      // No DTD, processing instructions or external entities. Only S3's root namespace attribute.
      const match = /^<([A-Za-z][\w]*)(?:\s+xmlns="[^"<>]*")?\s*(\/?)>$/.exec(token)
      if (!match || stack.length > 8) throw new Error('Invalid XML open')
      const element: Element = { name: match[1], text: '', children: [] }
      ;(stack.at(-1)?.children ?? roots).push(element)
      if (!match[2]) stack.push(element)
    } else {
      if (/&(?!(?:[^;&\s]+);)/.test(token)) throw new Error('Invalid XML entity')
      if (stack.length) stack.at(-1)!.text += decode(token)
      else if (token.trim()) throw new Error('Invalid XML text')
    }
  }
  if (stack.length || roots.length !== 1 || roots[0].name !== 'ListBucketResult') throw new Error('Invalid listing XML')
  return roots[0]
}
function field(node: Element, name: string, optional = false): string | undefined {
  const children = node.children.filter(child => child.name === name)
  if ((optional && !children.length)) return undefined
  if (children.length !== 1 || children[0].children.length) throw new Error('Invalid listing field')
  return children[0].text
}
export async function listObjects(run: Runner, maxPages = 10_000): Promise<ObjectInfo[]> {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('Invalid listing cap')
  const objects: ObjectInfo[] = [], keys = new Set<string>(), tokens = new Set<string>()
  let continuation: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const response = await run({ method: 'GET', key: '', headers: {}, query: {
      'list-type': '2', 'max-keys': '1000', ...(continuation ? { 'continuation-token': continuation } : {}),
    } })
    if (response.status !== 200) throw new Error('Listing failed')
    const root = xml(response.body), truncated = field(root, 'IsTruncated'), next = field(root, 'NextContinuationToken', true)
    const echo = field(root, 'ContinuationToken', true)
    if ((truncated !== 'true' && truncated !== 'false') || (echo !== undefined && echo !== continuation)) throw new Error('Inconsistent listing')
    const contents = root.children.filter(child => child.name === 'Contents'), count = field(root, 'KeyCount')
    if (!/^\d+$/.test(count ?? '') || Number(count) !== contents.length || contents.length > 1000) throw new Error('Inconsistent listing count')
    for (const entry of contents) {
      const key = field(entry, 'Key'), size = field(entry, 'Size'), modified = field(entry, 'LastModified')
      const uploaded = Date.parse(modified ?? '')
      if (!key || keys.has(key) || !/^\d+$/.test(size ?? '') || !Number.isSafeInteger(Number(size)) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(modified ?? '') || !Number.isFinite(uploaded)) throw new Error('Invalid listing object')
      keys.add(key)
      if (key !== runLockKey) objects.push({ key, size: Number(size), uploaded, checksum: '' })
    }
    if (truncated === 'false') {
      if (next !== undefined) throw new Error('Unexpected continuation token')
      return objects
    }
    if (!next || tokens.has(next) || !contents.length) throw new Error('Missing or repeated continuation token')
    tokens.add(next); continuation = next
  }
  throw new Error('Listing page cap exceeded')
}
