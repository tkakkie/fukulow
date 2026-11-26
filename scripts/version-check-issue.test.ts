import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planVersionIssue, syncVersionIssue } from './version-check-issue.ts'

const open = { number: 42, title: 'Version check', state: 'open' } as const
const closed = { ...open, state: 'closed' } as const

test('an all-clear report closes an open Issue, updates a closed one, or does nothing', () => {
  assert.deepEqual(planVersionIssue(false, [open]), { action: 'close', number: 42 })
  assert.deepEqual(planVersionIssue(false, [closed]), { action: 'update', number: 42 })
  assert.deepEqual(planVersionIssue(false, []), { action: 'none' })
})

test('an actionable report creates, updates, or reopens the Issue', () => {
  assert.deepEqual(planVersionIssue(true, []), { action: 'create' })
  assert.deepEqual(planVersionIssue(true, [open]), { action: 'update', number: 42 })
  assert.deepEqual(planVersionIssue(true, [closed]), { action: 'reopen', number: 42 })
})

test('the oldest exact-title Issue is updated and reopened even when it appears on a later page', () => {
  const repo = 'example/project'
  const calls: { args: string[], input?: string }[] = []
  const body = '## Upstream failures (not checked this run)\n- Tool: Error: network unreachable'
  syncVersionIssue((args, input) => {
    calls.push({ args, input })
    if (args[0] !== 'api') return ''
    return JSON.stringify([
      [{ ...open, number: 100 }, { ...open, number: 2, title: 'Version check follow-up' }],
      [{ ...open, number: 1, pull_request: {} }, closed],
    ])
  }, repo, { actionable: true, body })

  assert.deepEqual(calls, [
    { args: ['api', '--paginate', '--slurp', 'repos/example/project/issues?state=all&per_page=100'], input: undefined },
    { args: ['issue', 'edit', '42', '--repo', repo, '--body-file', '-'], input: body },
    { args: ['issue', 'reopen', '42', '--repo', repo], input: undefined },
  ])
})

test('an all-clear report writes the body before closing the open Issue', () => {
  const repo = 'example/project'
  const body = '## Newer versions available\n- none'
  const calls: { args: string[], input?: string }[] = []
  syncVersionIssue((args, input) => {
    if (args[0] === 'api') return JSON.stringify([[open]])
    calls.push({ args, input })
    return ''
  }, repo, { actionable: false, body })

  assert.deepEqual(calls, [
    { args: ['issue', 'edit', '42', '--repo', repo, '--body-file', '-'], input: body },
    { args: ['issue', 'close', '42', '--repo', repo], input: undefined },
  ])
})
