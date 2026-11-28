// Deletes superseded rust-cache keys on main (#926); dry run unless --apply.
import { execFileSync } from 'node:child_process'

export type CacheEntry = { id: number, key: string, ref: string, size_in_bytes: number,
  created_at: string, last_accessed_at: string }

// A superseded key that no run restored for a day is no longer in use.
export const rustIdle = 24 * 3_600_000
// Swatinem/rust-cache: v0-rust-<job>-<os>-<arch>-<environment hash>-<lockfile hash>. A newer key for the same
// job supersedes older ones, whichever hash changed. Docker layer blobs are never deleted: builds read only the
// layers they need, so an unread blob may still be referenced by the newest cache index (#926 review).
const rustKey = /^(v0-rust-.+)-[0-9a-f]{8}-[0-9a-f]{8}$/

export function selectPrunable(entries: CacheEntry[], now: number): CacheEntry[] {
  const unique = [...new Map(entries.map(entry => [entry.id, entry])).values()]
  const onMain = unique.filter(entry => entry.ref === 'refs/heads/main')
  const newest = new Map<string, number>()
  for (const entry of onMain) {
    const group = entry.key.match(rustKey)?.[1]
    if (group) newest.set(group, Math.max(newest.get(group) ?? 0, Date.parse(entry.created_at)))
  }
  return onMain.filter(entry => {
    const group = entry.key.match(rustKey)?.[1]
    // NaN timestamps compare false, so an unreadable entry is kept.
    return !!group && Date.parse(entry.created_at) < newest.get(group)!
      && now - Date.parse(entry.last_accessed_at) > rustIdle
  })
}

export type Gh = (args: string[]) => string

// Deletes each entry; one already gone (evicted or deleted meanwhile) does not stop the rest.
export function prune(gh: Gh, repo: string, entries: CacheEntry[], log: (line: string) => void) {
  for (const entry of entries) {
    try {
      gh(['api', '--method', 'DELETE', `repos/${repo}/actions/caches/${entry.id}`])
      log(`deleted ${entry.key}`)
    } catch (error) {
      if (!/HTTP 404/.test(String((error as { stderr?: unknown }).stderr ?? error))) throw error
      log(`already gone ${entry.key}`)
    }
  }
}

function run(argv: string[]) {
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY must be owner/name')
  const gh: Gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const pages = gh(['api', '--paginate', '--slurp',
    `repos/${repo}/actions/caches?per_page=100&sort=created_at&direction=desc`])
  const entries = (JSON.parse(pages) as { actions_caches: CacheEntry[] }[]).flatMap(page => page.actions_caches)
  const prunable = selectPrunable(entries, Date.now())
  const mib = (list: CacheEntry[]) => (list.reduce((sum, entry) => sum + entry.size_in_bytes, 0) / 2 ** 20).toFixed(0)
  console.log(`${entries.length} entries, ${mib(entries)} MiB; superseded ${prunable.length}, ${mib(prunable)} MiB`)
  for (const entry of prunable) console.log(`${entry.key} last restored ${entry.last_accessed_at}`)
  if (argv.includes('--apply')) prune(gh, repo, prunable, line => console.log(line))
}

if (import.meta.main) run(process.argv.slice(2))
