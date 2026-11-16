// Read-only sweep state for docs/workflow.md §1 (#453). It collects state and flags
// mechanical inconsistencies; §2 stays the only source of workflow decisions.
import { spawnSync } from 'node:child_process'

export type Gh = (args: string[]) => string
type Label = { name: string }
type Listed = { number: number, title: string, labels: Label[], createdAt: string }
type ListedPr = Listed & { headRefOid: string, isDraft: boolean, closingIssuesReferences: { number: number }[] }
type ListedIssue = Listed & { milestone: { title: string } | null, body: string }
type Merged = { number: number, headRefName: string, mergedAt: string }
type Check = { status?: string, conclusion?: string, state?: string }
type Viewed = { headRefOid: string, mergeable: string, statusCheckRollup: Check[] | null,
  reviewRequests: { login?: string, name?: string }[], latestReviews: { author: { login: string } }[] }

export class SweepError extends Error {}

const PAGE = 200
const statusOf = (item: Listed) => item.labels.map(l => l.name).filter(n => n.startsWith('status:'))

// Every call the script builds must be a read; anything else is refused before it runs.
export function isReadOnly(args: string[]): boolean {
  const [group, verb] = args
  if (group === 'pr') return ['list', 'view', 'checks'].includes(verb)
  if (group === 'issue') return ['list', 'view'].includes(verb)
  if (group === 'api') {
    const method = args.indexOf('-X')
    return method > 0 && args[method + 1] === 'GET' && !args.some(a => ['--input', '-F', '--field', '-f', '--raw-field'].includes(a))
  }
  return false
}

function json<T>(gh: Gh, args: string[]): T {
  if (!isReadOnly(args)) throw new SweepError(`refused non-read gh call: gh ${args.join(' ')}`)
  let output: string
  try {
    output = gh(args)
  } catch (error) {
    throw new SweepError(`gh ${args.join(' ')} failed: ${(error as Error).message}`)
  }
  try {
    return JSON.parse(output) as T
  } catch {
    throw new SweepError(`gh ${args.join(' ')} returned invalid JSON`)
  }
}

// Pages newest-first by exact creation timestamp (inclusive), so items sharing a date,
// or even a timestamp, are neither skipped nor duplicated. No progress is an error.
function listAll<T extends Listed>(gh: Gh, kind: 'pr' | 'issue', fields: string): T[] {
  const byNumber = new Map<number, T>()
  let before: string | undefined
  for (;;) {
    const search = before ? ['--search', `created:<=${before} sort:created-desc`] : []
    const page = json<T[]>(gh, [kind, 'list', '--state', 'open', '--limit', String(PAGE), '--json', fields, ...search])
    const size = byNumber.size
    for (const item of page) byNumber.set(item.number, item)
    if (page.length < PAGE) break
    const oldest = page.map(item => item.createdAt).sort()[0]
    if (byNumber.size === size || oldest === before) {
      throw new SweepError(`incomplete ${kind} listing: paging made no progress at ${oldest}`)
    }
    before = oldest
  }
  return [...byNumber.values()].sort((a, b) => b.number - a.number)
}

export function ciState(view: Viewed, listedHead: string): string {
  if (view.headRefOid !== listedHead) return 'head-changed'
  const checks = view.statusCheckRollup ?? []
  if (!checks.length) return 'missing'
  const result = (c: Check) => (c.conclusion || c.state || '').toUpperCase()
  if (checks.some(c => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(result(c)))) return 'red'
  if (checks.some(c => (c.status && c.status.toUpperCase() !== 'COMPLETED') || ['', 'PENDING', 'EXPECTED'].includes(result(c)))) return 'pending'
  return checks.every(c => ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(result(c))) ? 'green' : 'unknown'
}

export function copilotState(view: Viewed): string {
  const copilot = (name = '') => /copilot/i.test(name)
  if (view.latestReviews.some(r => copilot(r.author.login))) return 'finished'
  if (view.reviewRequests.some(r => copilot(r.login) || copilot(r.name))) return 'pending'
  return 'not-requested'
}

// Lines starting "Blocked by" or "Depends on" name blockers; other prose does not.
export function blockers(body: string): number[] {
  const lines = body.split('\n').filter(line => /^\s*(?:[-*]\s*)?(?:\*\*)?(?:blocked by|depends on)\b/i.test(line))
  return [...new Set(lines.flatMap(line => [...line.matchAll(/#(\d+)/g)].map(m => Number(m[1]))))]
}

export type Report = { lines: string[], flags: string[], human: string[], merged: string[], calls: number }

export function collect(gh: Gh): Report {
  let calls = 0
  const counted: Gh = args => { calls++; return gh(args) }
  const prs = listAll<ListedPr>(counted, 'pr', 'number,title,labels,headRefOid,isDraft,createdAt,closingIssuesReferences')
  const issues = listAll<ListedIssue>(counted, 'issue', 'number,title,labels,milestone,createdAt,body')
  const total = json<{ open_issues_count: number }>(counted, ['api', '-X', 'GET', 'repos/{owner}/{repo}']).open_issues_count
  if (prs.length + issues.length !== total) {
    throw new SweepError(`incomplete listing: ${prs.length} PRs + ${issues.length} Issues, GitHub reports ${total} open`)
  }
  const merged = json<Merged[]>(counted, ['pr', 'list', '--state', 'merged', '--limit', '30', '--json', 'number,headRefName,labels,mergedAt'])
  const openIssues = new Set(issues.map(i => i.number))
  const open = new Set([...openIssues, ...prs.map(p => p.number)])
  const report: Report = { lines: [], flags: [], human: [], merged: [], calls: 0 }
  const labelFlags = (kind: string, item: Listed) => {
    const status = statusOf(item)
    if (status.length > 1) report.flags.push(`${kind} #${item.number}: ${status.length} status labels (${status.join(', ')})`)
    if (!status.length) report.flags.push(`${kind} #${item.number}: no status label`)
    if (status.some(s => s === 'status:human-review' || s === 'status:needs-decision')) report.human.push(`${kind} #${item.number} [${status.join(',')}] ${item.title}`)
    return status.join(',') || 'none'
  }
  for (const pr of prs) {
    const status = labelFlags('PR', pr)
    // One view per PR, as §1 already queries mergeable for every open PR.
    const view = json<Viewed>(counted, ['pr', 'view', String(pr.number), '--json', 'headRefOid,mergeable,statusCheckRollup,reviewRequests,latestReviews'])
    for (const issue of pr.closingIssuesReferences) {
      if (!openIssues.has(issue.number)) report.flags.push(`PR #${pr.number}: linked Issue #${issue.number} is not open`)
    }
    const others = pr.labels.map(l => l.name).filter(n => !n.startsWith('status:'))
    report.lines.push(`PR #${pr.number} [${status}]${pr.isDraft ? ' draft' : ''} head=${pr.headRefOid.slice(0, 7)} ci=${ciState(view, pr.headRefOid)} mergeable=${view.mergeable} copilot=${copilotState(view)}${others.length ? ` {${others.join(',')}}` : ''} ${pr.title}`)
  }
  for (const issue of issues) {
    const status = labelFlags('Issue', issue)
    const labels = issue.labels.map(l => l.name)
    let blockedBy = ''
    if (labels.includes('blocked')) {
      const named = blockers(issue.body)
      blockedBy = named.length ? ` blocked-by=${named.map(n => `#${n}`).join(',')}` : ' blocked-by=?'
      // Only closed blockers need a lookup; an open one is unsatisfied as listed.
      if (named.length && named.every(n => !open.has(n))) {
        const done = named.every(n => {
          const item = json<{ state: string, state_reason?: string, pull_request?: { merged_at: string | null } }>(counted, ['api', '-X', 'GET', `repos/{owner}/{repo}/issues/${n}`])
          return item.pull_request ? item.pull_request.merged_at !== null : item.state === 'closed' && item.state_reason !== 'not_planned'
        })
        if (done) report.flags.push(`Issue #${issue.number}: blocked, but every named blocker is merged or closed (${named.map(n => `#${n}`).join(', ')})`)
      }
    }
    const others = labels.filter(n => !n.startsWith('status:'))
    report.lines.push(`Issue #${issue.number} [${status}] ${issue.milestone?.title ?? 'no-milestone'}${blockedBy}${others.length ? ` {${others.join(',')}}` : ''} ${issue.title}`)
  }
  report.merged = merged.map(m => `#${m.number} ${m.headRefName} ${m.mergedAt}`)
  report.calls = calls
  return report
}

export function format(report: Report): string {
  return [`## Items (${report.lines.length})`, ...report.lines,
    `## Flags (${report.flags.length})`, ...report.flags,
    `## Human-pending (${report.human.length})`, ...report.human,
    `## Recent merges (${report.merged.length})`, ...report.merged,
    `api-calls: ${report.calls}`].join('\n')
}

if (import.meta.main) {
  const gh: Gh = args => {
    const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr.trim() || `exit ${result.status}`)
    return result.stdout
  }
  try {
    const report = collect(gh)
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 1) : format(report))
  } catch (error) {
    // No partial list: §1 falls back to the separate gh calls.
    console.error(`sweep-state: ${(error as Error).message}\nNo state printed; use the gh calls in docs/workflow.md §1.`)
    process.exit(1)
  }
}
