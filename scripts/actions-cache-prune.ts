// Deletes superseded GitHub Actions cache entries on main (#926); dry run unless --apply.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export type CacheEntry = { id: number, key: string, ref: string, size_in_bytes: number,
  created_at: string, last_accessed_at: string }

const hour = 3_600_000
// A superseded rust-cache key that no run restored for a day is no longer in use.
export const rustIdle = 24 * hour
// Layer blobs carry no generation, so "superseded" means no build read them for four days.
export const blobIdle = 96 * hour
const main = 'refs/heads/main'
// Swatinem/rust-cache: v0-rust-<job>-<os>-<arch>-<environment hash>-<lockfile hash>. A newer key for the same
// job supersedes older ones, whichever hash changed.
const rustKey = /^(v0-rust-.+)-[0-9a-f]{8}-[0-9a-f]{8}$/

export function selectPrunable(entries: CacheEntry[], now: number): CacheEntry[] {
  const onMain = entries.filter(entry => entry.ref === main)
  const idleFor = (entry: CacheEntry) => now - Date.parse(entry.last_accessed_at)
  const newest = new Map<string, number>()
  for (const entry of onMain) {
    const group = entry.key.match(rustKey)?.[1]
    if (group) newest.set(group, Math.max(newest.get(group) ?? 0, Date.parse(entry.created_at)))
  }
  // A blob written after the newest index may belong to an export still in progress.
  const latestIndex = Math.max(0, ...onMain.filter(entry => entry.key.startsWith('index-'))
    .map(entry => Date.parse(entry.created_at)))
  return onMain.filter(entry => {
    const group = entry.key.match(rustKey)?.[1]
    if (group) return Date.parse(entry.created_at) < newest.get(group)! && idleFor(entry) > rustIdle
    if (entry.key.startsWith('buildkit-blob-')) {
      return Date.parse(entry.created_at) < latestIndex && idleFor(entry) > blobIdle
    }
    return false // indexes, npm, gitleaks and anything unknown are never deleted
  })
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function run(argv: string[]) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY must be owner/name')
  const apply = argv.includes('--apply')
  const pages = gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/caches?per_page=100`])
  const entries = (JSON.parse(pages) as { actions_caches: CacheEntry[] }[]).flatMap(page => page.actions_caches)
  const prunable = selectPrunable(entries, Date.now())
  const mib = (list: CacheEntry[]) => (list.reduce((sum, entry) => sum + entry.size_in_bytes, 0) / 2 ** 20).toFixed(0)
  console.log(`${entries.length} entries, ${mib(entries)} MiB; ${apply ? 'deleting' : 'would delete'} ${prunable.length}, ${mib(prunable)} MiB`)
  for (const entry of prunable) {
    console.log(`${entry.key} ${(entry.size_in_bytes / 2 ** 20).toFixed(0)} MiB, last read ${entry.last_accessed_at}`)
    if (apply) gh(['api', '--method', 'DELETE', `repos/${repo}/actions/caches/${entry.id}`])
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) run(process.argv.slice(2))
