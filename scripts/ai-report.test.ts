import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkForLocalPaths, composeBody, extractReport, extractVerdict, stripLocalLinks } from './ai-report.ts'

const signature = 'AI: Codex / model: gpt-6.2-sol / effort: medium'
const resultEvent = (response: string | number) => JSON.stringify({
  event: 'result',
  result: { conversation_id: 'test', status: 'completed', response, duration_seconds: 1, num_turns: 1, usage: {} },
})

test('extracts a Codex Markdown report unchanged', () => {
  const report = '# Result\n\n- Checked the script.\nVerdict: pass\n'
  assert.equal(extractReport(report), report)
})

test('extracts the response of the last Antigravity result event', () => {
  const report = 'Checked the script.\nVerdict: pass'
  const log = [
    resultEvent('Earlier report'),
    'stderr from Antigravity',
    resultEvent(report),
    'null',
    '{"event":"progress","response":"Later progress"}',
    '',
  ].join('\r\n')
  assert.equal(extractReport(log), report)
})

test('rejects Antigravity logs without a usable final result', () => {
  assert.throws(() => extractReport('stderr\n{"event":"progress"}'), /no result event/)
  assert.throws(() => extractReport('stderr only', true), /no result event/)
  const earlier = resultEvent('Earlier report')
  assert.throws(() => extractReport(`${earlier}\n{"event":"result","response":"Top-level response"}`), /no string response/)
  assert.throws(() => extractReport(`${earlier}\n${resultEvent(1)}`), /no string response/)
})

test('strips each local Markdown link target while keeping labels and other links', () => {
  const targets = ['file:///var/log/report', '/Users/test/repo/file.ts:12', '/home/test/file.ts', '/private/var/file.ts', '/tmp/report.md']
  const links = targets.map((target, index) => `[source ${index}](${target})`)
  assert.equal(stripLocalLinks(links.join(' ')), targets.map((_, index) => `[source ${index}]`).join(' '))
  assert.equal(stripLocalLinks('[source](</Users/test/my repo/file.ts>) [other](/tmp/dir(v2)/file.ts)'), '[source] [other]')
  const nonlocal = '[web](https://example.com/file.ts) [relative](scripts/file.ts)'
  assert.equal(stripLocalLinks(nonlocal), nonlocal)
})

test('refuses every prohibited path prefix remaining after stripping', () => {
  for (const path of ['/Users/test', '/home/test', 'file:///var/file', '/private/tmp/file']) {
    const report = stripLocalLinks(`See [source](/tmp/file) or ${path}`)
    assert.throws(() => checkForLocalPaths(report), /Refusing to publish/)
  }
  assert.doesNotThrow(() => checkForLocalPaths(stripLocalLinks('See [source](/private/tmp/file).')))
})

test('keeps the signature last with or without a title', () => {
  assert.equal(composeBody('Report\n\n', signature, '## Review'), `## Review\n\nReport\n\n${signature}`)
  assert.equal(composeBody('Report\n', signature), `Report\n\n${signature}`)
})

test('finds the last line beginning with Verdict', () => {
  assert.equal(extractVerdict('Verdict: draft\r\nVerdict: pass\r\n> Verdict: quoted\r\nDone'), 'Verdict: pass')
  assert.equal(extractVerdict('Draft verdict: pass\n Verdict: indented'), undefined)
})

test('CLI prints the sanitized dry-run body and verdict on separate streams', (t) => {
  const result = runReport(t, 'review.jsonl', resultEvent('Checked [source](/tmp/file).\nVerdict: pass'),
    ['--pr', '1035', '--title', '## Review', '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `## Review\n\nChecked [source].\nVerdict: pass\n\n${signature}\n`)
  assert.equal(result.stderr, 'Verdict: pass\n')
})

test('CLI refuses a leak in the report or title before printing or posting', (t) => {
  for (const result of [
    runReport(t, 'review.md', 'Verdict: see /home/test/file', ['--issue', '1035']),
    runReport(t, 'review.md', 'Verdict: pass', ['--issue', '1035', '--title', '## /private/tmp/report', '--dry-run']),
  ]) {
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'Refusing to publish a report containing a local path\n')
  }
})

test('CLI refuses a JSONL log containing only stderr', (t) => {
  const result = runReport(t, 'review.jsonl', 'stderr only', ['--issue', '1035', '--dry-run'])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Antigravity log has no result event\n')
})

function runReport(t: TestContext, name: string, contents: string, args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-report-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = join(directory, name)
  writeFileSync(source, contents)
  const script = fileURLToPath(new URL('./ai-report.ts', import.meta.url))
  return spawnSync(process.execPath, [script, '--source', source, '--signature', signature, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: directory },
  })
}
