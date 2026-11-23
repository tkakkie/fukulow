// Publish gate (#808): the tagged commit is on main and its main push CI succeeded.
import { pathToFileURL } from 'node:url'

// Every workflow that runs on a main push. Their jobs include all required checks that
// main commits get (web, server, docker, lint, migrations, checks, scan); smoke and
// budget-changes run only on the pull request. e2e-compose is the release-candidate gate.
export const requiredWorkflows = ['.github/workflows/ci.yml', '.github/workflows/e2e-compose.yml',
  '.github/workflows/gitleaks.yml', '.github/workflows/security.yml']

export type WorkflowRun = { id: number, path: string, event: string, head_branch: string, head_sha: string,
  status: string, conclusion: string | null }

// compareStatus is GitHub's status for `<sha>...main`: identical or ahead means the commit is on main.
export function gateFailures(sha: string, compareStatus: string, runs: WorkflowRun[]): string[] {
  const failures: string[] = []
  if (!['identical', 'ahead'].includes(compareStatus)) failures.push(`commit ${sha} is not on main (compare status ${compareStatus})`)
  for (const path of requiredWorkflows) {
    const run = runs.filter(run => run.path === path && run.event === 'push' && run.head_branch === 'main' && run.head_sha === sha)
      .sort((a, b) => b.id - a.id)[0]
    if (!run) failures.push(`${path}: no main push run for ${sha}`)
    else if (run.status !== 'completed' || run.conclusion !== 'success') {
      failures.push(`${path}: run ${run.id} is ${run.status}/${run.conclusion ?? 'none'}, not completed/success`)
    }
  }
  return failures
}

async function api(path: string): Promise<unknown> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, { headers: {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' } })
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`)
  return response.json()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { GITHUB_REPOSITORY: repository, RELEASE_SHA: sha } = process.env
  if (!repository || !sha || !/^[0-9a-f]{40}$/.test(sha) || !process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_REPOSITORY, RELEASE_SHA (40 hex) and GITHUB_TOKEN are required')
  }
  const compare = await api(`/repos/${repository}/compare/${sha}...main?per_page=1`) as { status: string }
  const runs = await api(`/repos/${repository}/actions/runs?head_sha=${sha}&event=push&branch=main&per_page=100`) as
    { workflow_runs: WorkflowRun[] }
  const failures = gateFailures(sha, compare.status, runs.workflow_runs)
  if (failures.length) {
    for (const failure of failures) console.error(`release gate: ${failure}`)
    console.error('Wait for or re-run CI on main, then re-run this release; never move the tag.')
    process.exit(1)
  }
  console.log(`release gate: ${sha} is on main and ${requiredWorkflows.length} main push workflows succeeded`)
}
