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
    '',
    '  ',
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
  assert.throws(() => extractReport('stderr\n{"event":"progress"}', true), /no result event/)
  assert.throws(() => extractReport('\n{"event":"progress"}'), /no result event/)
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
  for (const path of ['/Users', '/Users/test', '/home/test', 'file:///var/file', '/private/tmp/file']) {
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
  const result = runReport(t, 'review.jsonl', `stderr\n${resultEvent('Checked [source](/tmp/file).\nVerdict: pass')}`,
    ['--pr', '1035', '--title', '## Review', '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `## Review\n\nChecked [source].\nVerdict: pass\n\n${signature}\n`)
  assert.equal(result.stderr, 'Verdict: pass\n')
})

test('CLI preserves a Markdown report quoting Antigravity progress and result events', (t) => {
  const report = ['# Review', '', '```jsonl', '{"event":"progress"}', resultEvent('Quoted report'), '```'].join('\n')
  assert.equal(extractReport(report), report)
  const result = runReport(t, 'review.md', report, ['--pr', '1035', '--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `${report}\n\n${signature}\n`)
  assert.equal(result.stderr, '')
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

for (const [description, args] of [
  ['missing target', []],
  ['both targets', ['--pr', '1035', '--issue', '1035']],
  ['zero PR number', ['--pr', '0']],
  ['zero issue number', ['--issue', '0']],
  ['non-numeric PR number', ['--pr', 'invalid']],
  ['non-numeric issue number', ['--issue', 'invalid']],
] as const) {
  test(`CLI rejects ${description}`, (t) => {
    const result = runReport(t, 'review.md', 'Report', [...args, '--dry-run'])
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'Specify either --pr N or --issue N with a positive number\n')
  })
}

for (const [description, invalidSignature] of [
  ['missing signature', null],
  ['malformed signature', 'Codex / gpt-6.2-sol / medium'],
  ['multi-line signature', `${signature}\nExtra line`],
  ['signature with a trailing newline', `${signature}\n`],
  ['whitespace-only name', 'AI:   / model: gpt-6.2-sol / effort: medium'],
  ['whitespace-only model', 'AI: Codex / model:   / effort: medium'],
  ['whitespace-only effort', 'AI: Codex / model: gpt-6.2-sol / effort:  '],
] as const) {
  test(`CLI rejects ${description}`, (t) => {
    const result = runReport(t, 'review.md', 'Report', ['--pr', '1035', '--dry-run'], { signature: invalidSignature })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^Specify a single-line --signature /)
  })
}

test('CLI rejects a missing source', (t) => {
  const result = runReport(t, 'review.md', 'Report', ['--pr', '1035', '--dry-run'], { includeSource: false })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Specify --source FILE\n')
})

test('CLI rejects a multi-line title', (t) => {
  const result = runReport(t, 'review.md', 'Report', ['--pr', '1035', '--title', 'First\nSecond', '--dry-run'])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '--title must be a single line\n')
})

for (const target of ['pr', 'issue']) {
  test(`CLI posts the body on stdin to gh ${target} comment`, (t) => {
    const result = runReport(t, 'review.md', 'Checked [source](/tmp/file).\nVerdict: pass', [`--${target}`, '1035'], {
      fakeGh: `printf '%s\\0' "$@"\n/bin/cat`,
    })
    assert.equal(result.status, 0, result.stderr)
    const body = `Checked [source].\nVerdict: pass\n\n${signature}`
    assert.deepEqual(result.stdout.split('\0'), [target, 'comment', '1035', '--body-file', '-', body])
    assert.equal(result.stderr, 'Verdict: pass\n')
  })
}

test('CLI exits with code 1 when gh exits non-zero', (t) => {
  const result = runReport(t, 'review.md', 'Verdict: pass', ['--pr', '1035'], { fakeGh: 'exit 7' })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'gh pr comment failed (7)\n')
})

test('CLI exits with code 1 when gh is missing', (t) => {
  const result = runReport(t, 'review.md', 'Verdict: pass', ['--issue', '1035'])
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /spawnSync gh ENOENT/)
})

function runReport(t: TestContext, name: string, contents: string, args: string[], {
  signature: reportSignature = signature,
  includeSource = true,
  fakeGh,
}: { signature?: string | null; includeSource?: boolean; fakeGh?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ai-report-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = join(directory, name)
  const options: string[] = []
  if (includeSource) {
    writeFileSync(source, contents)
    options.push('--source', source)
  }
  if (reportSignature !== null) options.push('--signature', reportSignature)
  if (fakeGh !== undefined) writeFileSync(join(directory, 'gh'), `#!/bin/bash\n${fakeGh}\n`, { mode: 0o755 })
  const script = fileURLToPath(new URL('./ai-report.ts', import.meta.url))
  return spawnSync(process.execPath, [script, ...options, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: directory },
  })
}
