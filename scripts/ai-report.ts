import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

function parseAntigravityEvent(line: string) {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    // Antigravity writes stderr to the same log as its JSON events.
    return undefined
  }
  if (record && typeof record === 'object' && 'event' in record && typeof record.event === 'string') return record
}

export function extractReport(source: string, isJsonLines = false): string {
  const lines = source.split(/\r?\n/).map(line => line.trim())
  if (!isJsonLines && !parseAntigravityEvent(lines.find(line => line.length > 0) ?? '')) return source

  for (const line of lines.reverse()) {
    const record = parseAntigravityEvent(line)
    if (record?.event !== 'result') continue
    const result = 'result' in record ? record.result : undefined
    if (!result || typeof result !== 'object' || !('response' in result) || typeof result.response !== 'string') {
      throw new Error('Antigravity result event has no string response')
    }
    return result.response
  }
  throw new Error('Antigravity log has no result event')
}

export function stripLocalLinks(report: string): string {
  const localTarget = String.raw`(?:file:\/\/|\/(?:Users|home|private|tmp)\/)`
  const barePath = String.raw`(?:[^\s()<>\\]|\\[^\r\n]|\([^()\r\n]*\))*`
  const link = new RegExp(String.raw`(\[(?:[^\[\]\\\r\n]|\\[^\r\n])+\])\(\s*(?:<${localTarget}[^>\r\n]*>|${localTarget}${barePath})\s*\)`, 'g')
  return report.replace(link, '$1')
}

export function checkForLocalPaths(body: string): void {
  if (/\/Users|\/home\/|file:\/\/|\/private\/tmp/.test(body)) {
    throw new Error('Refusing to publish a report containing a local path')
  }
}

export function composeBody(report: string, signature: string, title?: string): string {
  const heading = title === undefined ? '' : `${title}\n\n`
  return `${heading}${report.trimEnd()}\n\n${signature}`
}

export function extractVerdict(report: string): string | undefined {
  return report.split(/\r?\n/).findLast(line => line.startsWith('Verdict:'))
}

function postComment(target: 'pr' | 'issue', number: string, body: string): void {
  const result = spawnSync('gh', [target, 'comment', number, '--body-file', '-'], {
    input: body,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`gh ${target} comment failed (${result.signal ?? result.status})`)
}

function main(args: string[]): void {
  const { values } = parseArgs({ args, options: {
    pr: { type: 'string' },
    issue: { type: 'string' },
    source: { type: 'string' },
    signature: { type: 'string' },
    title: { type: 'string' },
    'dry-run': { type: 'boolean' },
  } })
  const { pr, issue, source, signature, title } = values
  const number = pr ?? issue
  if ((pr !== undefined && issue !== undefined) || !number || !/^[1-9]\d*$/.test(number)) {
    throw new Error('Specify either --pr N or --issue N with a positive number')
  }
  if (!source) throw new Error('Specify --source FILE')
  if (!signature || !/^AI: .*\S.* \/ model: .*\S.* \/ effort: .*\S.*$/.test(signature)) {
    throw new Error('Specify a single-line --signature "AI: <name> / model: <id> / effort: <level>"')
  }
  if (title !== undefined && /[\r\n]/.test(title)) throw new Error('--title must be a single line')

  const report = stripLocalLinks(extractReport(readFileSync(source, 'utf8'), source.endsWith('.jsonl')))
  const body = composeBody(report, signature, title)
  checkForLocalPaths(body)
  if (values['dry-run']) console.log(body)
  else postComment(pr === undefined ? 'issue' : 'pr', number, body)

  const verdict = extractVerdict(report)
  if (verdict !== undefined) console.error(verdict)
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
