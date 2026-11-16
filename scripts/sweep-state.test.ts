import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blockers, collect, format, isReadOnly, SweepError, type Gh } from './sweep-state.ts'

const label = (...names: string[]) => names.map(name => ({ name }))
const pr = (number: number, extra: object = {}) => ({ number, title: `PR ${number}`, labels: label('status:ai-review'),
  headRefOid: `head${number}`, isDraft: false, createdAt: '2026-11-16T00:00:00Z', closingIssuesReferences: [], ...extra })
const issue = (number: number, extra: object = {}) => ({ number, title: `Issue ${number}`, labels: label('status:ready'),
  milestone: { title: 'Backlog' }, createdAt: '2026-11-16T00:00:00Z', body: '', ...extra })
const required = ['web', 'server', 'docker']
const green = required.map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }))
const view = (head: string, extra: object = {}) => ({ headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: green,
  reviewRequests: [], latestReviews: [], ...extra })

// A fake gh keyed by the call shape; every call is recorded for the read-only check.
function fake(state: { prs?: object[][], issues?: object[][], views?: Record<number, object | Error>,
  total?: number, items?: Record<number, object>, rules?: object[] }) {
  const calls: string[][] = []
  const pages = { pr: [...(state.prs ?? [[]])], issue: [...(state.issues ?? [[]])] }
  const gh: Gh = args => {
    calls.push(args)
    const [group, verb] = args
    if ((group === 'pr' || group === 'issue') && verb === 'list' && args.includes('open')) return JSON.stringify(pages[group].shift() ?? [])
    if (group === 'pr' && verb === 'list') return '[]'
    if (group === 'pr' && verb === 'view') {
      const result = state.views?.[Number(args[2])]
      if (result instanceof Error) throw result
      return JSON.stringify(result)
    }
    if (group === 'api' && args.at(-1) === 'repos/{owner}/{repo}') {
      const listed = new Set([...(state.prs ?? []).flat(), ...(state.issues ?? []).flat()].map(i => (i as { number: number }).number))
      return JSON.stringify({ open_issues_count: state.total ?? listed.size })
    }
    if (group === 'api' && args.at(-1) === 'repos/{owner}/{repo}/rules/branches/main') {
      return JSON.stringify(state.rules ?? [{ type: 'pull_request' },
        { type: 'required_status_checks', parameters: { required_status_checks: required.map(context => ({ context })) } }])
    }
    const item = args.at(-1)?.match(/issues\/(\d+)$/)
    if (group === 'api' && item) return JSON.stringify(state.items?.[Number(item[1])])
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
  return { gh, calls }
}

const line = (report: ReturnType<typeof collect>, prefix: string) => report.lines.find(l => l.startsWith(prefix + ' '))!

test('CI: green on an older SHA, missing and in progress are never green', () => {
  const { gh } = fake({ prs: [[pr(1), pr(2), pr(3), pr(4), pr(5), pr(6), pr(7)]], views: {
    6: view('head6', { statusCheckRollup: green.filter(c => c.name !== 'docker') }),
    7: view('head7', { statusCheckRollup: [{ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
    1: view('newer-head'), 2: view('head2', { statusCheckRollup: [] }),
    3: view('head3', { statusCheckRollup: [{ name: 'web', status: 'IN_PROGRESS', conclusion: '' }, ...green.slice(1)] }),
    4: view('head4', { statusCheckRollup: [...green, { status: 'QUEUED', conclusion: '' }] }), 5: view('head5') } })
  const report = collect(gh)
  assert.match(line(report, 'PR #1'), /ci=head-changed/)
  assert.match(line(report, 'PR #2'), /ci=missing/)
  assert.match(line(report, 'PR #3'), /ci=pending/)
  assert.match(line(report, 'PR #4'), /ci=pending/)
  assert.match(line(report, 'PR #5'), /ci=green/)
  assert.match(line(report, 'PR #6'), /ci=missing/, 'a required check absent from a green rollup')
  assert.match(line(report, 'PR #7'), /ci=missing/, 'only non-required checks reported')
})

test('CI: a ruleset without required checks cannot confirm green', () => {
  assert.throws(() => collect(fake({ prs: [[pr(1)]], views: { 1: view('head1') }, rules: [{ type: 'pull_request' }] }).gh),
    /lists no required checks/)
})

test('Mergeable: UNKNOWN and CONFLICTING are reported as such', () => {
  const { gh } = fake({ prs: [[pr(1), pr(2)]], views: { 1: view('head1', { mergeable: 'UNKNOWN' }), 2: view('head2', { mergeable: 'CONFLICTING' }) } })
  const report = collect(gh)
  assert.match(line(report, 'PR #1'), /mergeable=UNKNOWN/)
  assert.match(line(report, 'PR #2'), /mergeable=CONFLICTING/)
})

test('Copilot: not requested, requested and pending, finished, re-requested after a review', () => {
  const { gh } = fake({ prs: [[pr(1), pr(2), pr(3), pr(4)]], views: { 1: view('head1'),
    4: view('head4', { reviewRequests: [{ login: 'Copilot' }], latestReviews: [{ author: { login: 'copilot-pull-request-reviewer' } }] }),
    2: view('head2', { reviewRequests: [{ login: 'Copilot' }] }),
    3: view('head3', { latestReviews: [{ author: { login: 'copilot-pull-request-reviewer' } }] }) } })
  const report = collect(gh)
  assert.match(line(report, 'PR #1'), /copilot=not-requested/)
  assert.match(line(report, 'PR #2'), /copilot=pending/)
  assert.match(line(report, 'PR #3'), /copilot=finished/)
  assert.match(line(report, 'PR #4'), /copilot=pending/)
})

test('Blocked: one of several blockers merged is not flagged; all merged is', () => {
  const merged = { state: 'closed', pull_request: { merged_at: '2026-11-15T00:00:00Z' } }
  const { gh } = fake({ issues: [[
    issue(10, { labels: label('status:ready', 'blocked'), body: 'Blocked by #1, #2.' }),
    issue(11, { labels: label('status:ready', 'blocked'), body: 'Intro\nDepends on #1 and #3.' }),
    issue(12, { labels: label('status:ready', 'blocked'), body: 'Blocked by #4.' }),
    issue(4)]], items: { 1: merged, 2: { state: 'open' }, 3: merged } })
  const report = collect(gh)
  assert.ok(!report.flags.some(f => f.startsWith('Issue #10:')))
  assert.ok(report.flags.some(f => f.startsWith('Issue #11: blocked, but every named blocker')))
  assert.ok(!report.flags.some(f => f.startsWith('Issue #12:')), 'an open blocker is unsatisfied')
  assert.deepEqual(blockers('See #9 later.\n- **Blocked by** #5 step 4\nnot blocked by #6'), [5])
})

test('Labels: more than one status label, none, and the human-pending list', () => {
  const { gh } = fake({ prs: [[pr(1, { labels: label('status:working', 'status:ai-review') })]], views: { 1: view('head1') },
    issues: [[issue(2, { labels: [] }), issue(3, { labels: label('status:needs-decision') }), issue(4, { labels: label('status:human-review') })]] })
  const report = collect(gh)
  assert.ok(report.flags.includes('PR #1: 2 status labels (status:working, status:ai-review)'))
  assert.ok(report.flags.includes('Issue #2: no status label'))
  assert.deepEqual(report.human.map(h => h.split(' [')[0]), ['Issue #4', 'Issue #3'])
})

test('Linked Issue already closed is flagged', () => {
  const { gh } = fake({ prs: [[pr(1, { closingIssuesReferences: [{ number: 7 }, { number: 8 }] })]], issues: [[issue(8)]], views: { 1: view('head1') } })
  assert.deepEqual(collect(gh).flags, ['PR #1: linked Issue #7 is not open'])
})

test('Over 200 items on one date page by exact timestamp and de-duplicate the overlap', () => {
  const first = Array.from({ length: 200 }, (_, i) => issue(400 - i, { createdAt: `2026-11-16T10:00:${String(59 - Math.floor(i / 4)).padStart(2, '0')}Z` }))
  const oldest = first.at(-1)!.createdAt
  // The second page repeats every item at the boundary timestamp, then continues.
  const second = [...first.filter(i => i.createdAt === oldest), ...Array.from({ length: 30 }, (_, i) => issue(150 - i, { createdAt: '2026-11-16T09:00:00Z' }))]
  const { gh, calls } = fake({ issues: [first, second] })
  const report = collect(gh)
  assert.equal(report.lines.length, 230)
  assert.equal(new Set(report.lines.map(l => l.split(' ')[1])).size, 230)
  assert.ok(calls.some(c => c.join(' ').includes(`created:<=${oldest}`)))
})

test('Paging with no progress and a count mismatch are incomplete listings', () => {
  const same = Array.from({ length: 200 }, (_, i) => issue(300 - i))
  assert.throws(() => collect(fake({ issues: [same, same] }).gh), /incomplete issue listing/)
  assert.throws(() => collect(fake({ issues: [[issue(1)]], total: 2 }).gh), /incomplete listing: 0 PRs \+ 1 Issues, GitHub reports 2/)
})

test('Partial API failure prints no list and the CLI exits non-zero', async () => {
  const { gh } = fake({ prs: [[pr(1), pr(2)]], views: { 1: view('head1'), 2: new Error('HTTP 502') } })
  assert.throws(() => collect(gh), (error: unknown) => error instanceof SweepError && /pr view 2 .*HTTP 502/.test(error.message))
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, chmodSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const bin = mkdtempSync(join(tmpdir(), 'sweep-gh-'))
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "boom" >&2\nexit 1\n')
  chmodSync(join(bin, 'gh'), 0o755)
  const result = spawnSync(process.execPath, [new URL('./sweep-state.ts', import.meta.url).pathname], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /boom[\s\S]*No state printed/)
})

test('Read-only: every gh call the script builds is a read, and writes are refused', () => {
  const { gh, calls } = fake({ prs: [[pr(1)]], views: { 1: view('head1') },
    issues: [[issue(2, { labels: label('status:ready', 'blocked'), body: 'Blocked by #9' })]], items: { 9: { state: 'closed' } } })
  const report = collect(gh)
  assert.ok(calls.length > 4)
  for (const call of calls) assert.ok(isReadOnly(call), call.join(' '))
  assert.equal(report.calls, calls.length)
  assert.match(format(report), /api-calls: \d+$/)
  for (const write of [['pr', 'edit', '1', '--add-label', 'x'], ['issue', 'comment', '1'], ['pr', 'merge', '1'],
    ['api', 'repos/{owner}/{repo}/issues/1/labels', '-f', 'labels=x'], ['api', '-X', 'POST', 'graphql'],
    ['api', '-X', 'GET', 'x', '--input', 'file'], ['api', '-X', 'GET', 'x', '--input=file'],
    ['api', '-X', 'GET', 'x', '-f=k=v'], ['api', '-X', 'GET', 'x', '-Fk=v'], ['api', '-X', 'GET', 'x', '--raw-field=k=v'], ['label', 'list']]) assert.ok(!isReadOnly(write), write.join(' '))
})
