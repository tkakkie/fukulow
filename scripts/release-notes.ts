// Release notes header (#808): image digests, upgrade notes and rollback limits.
// GitHub appends its generated change list below this text.
import { execFileSync } from 'node:child_process'
import { imageRepository } from './release-oci.ts'

export type Notes = { tag: string, version: string, tags: string[], index: string, platforms: Record<string, string>,
  previous?: string, migrations: string[], configChanges: string[] }

// Files whose changes can need operator action on upgrade.
const configPaths = ['compose.yml', '.env.example', 'deploy']

export function releaseNotes(notes: Notes): string {
  const pinned = `${notes.version}@${notes.index}`
  const since = notes.previous ? `since ${notes.previous}` : 'in this first release'
  const list = (items: string[], none: string) => items.length ? items.map(item => `- \`${item}\``).join('\n') : `- ${none}`
  return `## Image

\`${imageRepository}:${pinned}\`

- Index digest: \`${notes.index}\` (tags: ${notes.tags.map(tag => `\`${tag}\``).join(', ')})
${Object.entries(notes.platforms).map(([architecture, digest]) => `- linux/${architecture}: \`${digest}\``).join('\n')}
- Set \`FUKULOW_VERSION=${pinned}\` in \`.env\`, then \`docker compose pull\` and \`docker compose up -d\` (the proxy comes from \`COMPOSE_PROFILES\`).
- Verify: \`gh attestation verify oci://${imageRepository}@${notes.index} --repo tkakkie/fukulow\` (build provenance; add \`--predicate-type https://spdx.dev/Document/v2.3\` for the SBOM).

## Upgrade notes

Take and drill a backup before upgrading. Migrations added ${since}:
${list(notes.migrations, 'none')}

Deployment configuration changed ${since} (review the diff before upgrading):
${list(notes.configChanges, 'none')}

## Rollback

Migrations are append-only and forward-only, and the app refuses to start on a schema with migrations it does not know. ${
  notes.migrations.length
    ? 'This release adds migrations, so an older image cannot run on the upgraded database: rolling back needs a restore of the pre-upgrade backup.'
    : 'This release adds no migration, so setting `FUKULOW_VERSION` back to the previous release is enough.'
} See docs/workflow.md "Releases".
`
}

function changed(from: string | undefined, to: string, paths: string[], filter?: string): string[] {
  const args = from ? ['diff', '--name-only', ...(filter ? [`--diff-filter=${filter}`] : []), from, to, '--', ...paths]
    : ['ls-tree', '-r', '--name-only', to, '--', ...paths]
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)
}

if (import.meta.main) {
  const [tag, version, tags, index, amd64, arm64, previous] = process.argv.slice(2)
  if (!/^sha256:[a-f0-9]{64}$/.test(index ?? '')) throw new Error('usage: release-notes.ts <tag> <version> <tags> <index> <amd64> <arm64> [previous]')
  process.stdout.write(releaseNotes({ tag, version, tags: tags.split(','), index, platforms: { amd64, arm64 },
    previous: previous || undefined, migrations: changed(previous || undefined, tag, ['server/migrations'], 'A'),
    configChanges: previous ? changed(previous, tag, configPaths) : [] }))
}
