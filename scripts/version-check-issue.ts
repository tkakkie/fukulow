import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { VersionReport } from './version-report.ts'

const title = 'Version check'
type Issue = { number: number, title: string, state: 'open' | 'closed', pull_request?: object }
type Plan = { action: 'none' | 'create' } | { action: 'update' | 'reopen' | 'close', number: number }
type Gh = (args: string[], input?: string) => string

export function planVersionIssue(actionable: boolean, issues: Issue[]): Plan {
  let oldest: Issue | undefined
  for (const issue of issues) {
    if (issue.title !== title || issue.pull_request) continue
    if (!oldest || issue.number < oldest.number) oldest = issue
  }
  if (!oldest) return { action: actionable ? 'create' : 'none' }
  const number = oldest.number
  if (actionable && oldest.state === 'closed') return { action: 'reopen', number }
  if (!actionable && oldest.state === 'open') return { action: 'close', number }
  return { action: 'update', number }
}

export function syncVersionIssue(gh: Gh, repo: string, report: Pick<VersionReport, 'actionable' | 'body'>) {
  // Page through repository Issues directly so search ranking and indexing cannot hide an existing Issue.
  const json = gh(['api', '--paginate', '--slurp', `repos/${repo}/issues?state=all&per_page=100`])
  const plan = planVersionIssue(report.actionable, (JSON.parse(json) as Issue[][]).flat())
  const bodyArgs = ['--repo', repo, '--body-file', '-']
  switch (plan.action) {
    case 'none':
      return
    case 'create':
      gh(['issue', 'create', '--title', title, '--milestone', 'Backlog', ...bodyArgs], report.body)
      return
    default: {
      const number = String(plan.number)
      gh(['issue', 'edit', number, ...bodyArgs], report.body)
      if (plan.action !== 'update') gh(['issue', plan.action, number, '--repo', repo])
    }
  }
}

if (import.meta.main) {
  const path = process.argv[2]
  const repo = process.env.GITHUB_REPOSITORY
  if (!path || !repo) throw new Error('Expected a report path and GITHUB_REPOSITORY')
  const report = JSON.parse(readFileSync(path, 'utf8')) as VersionReport
  const gh: Gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 })
  syncVersionIssue(gh, repo, report)
}
