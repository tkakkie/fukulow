// Release tag rules (#808): SemVer tags, the image tags a release moves and the previous release.
import { execFileSync } from 'node:child_process'

export type Version = { tag: string, version: string, major: number, minor: number, patch: number, prerelease: string[] }

const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
// SemVer 2.0.0 without build metadata: OCI tags cannot contain "+".
const tagPattern = new RegExp(`^v(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?$`)

export function parseTag(tag: string): Version {
  const match = tagPattern.exec(tag)
  // OCI tags allow at most 128 characters.
  if (!match || tag.length > 129) throw new Error(`release tag must be vX.Y.Z or vX.Y.Z-pre (SemVer, no build metadata): ${JSON.stringify(tag)}`)
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number)
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error(`release tag number out of range: ${tag}`)
  return { tag, version: tag.slice(1), major, minor, patch, prerelease: match[4] ? match[4].split('.') : [] }
}

function compareIdentifiers(a: string, b: string): number {
  const [numericA, numericB] = [/^\d+$/.test(a), /^\d+$/.test(b)]
  if (numericA && numericB) return Math.sign(Number(a) - Number(b))
  if (numericA !== numericB) return numericA ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

// SemVer precedence: a pre-release ranks below its release.
export function compareVersions(a: Version, b: Version): number {
  for (const key of ['major', 'minor', 'patch'] as const) if (a[key] !== b[key]) return Math.sign(a[key] - b[key])
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length)
  for (let index = 0; index < Math.min(a.prerelease.length, b.prerelease.length); index++) {
    const order = compareIdentifiers(a.prerelease[index], b.prerelease[index])
    if (order) return order
  }
  return Math.sign(a.prerelease.length - b.prerelease.length)
}

export type ReleasePlan = { version: string, prerelease: boolean, tags: string[], latest: boolean, previous?: string }

// A pre-release publishes only its own tag. A release moves X.Y and latest only forward,
// so a patch for an older line never takes them back.
export function planRelease(tag: string, existingTags: string[]): ReleasePlan {
  const current = parseTag(tag)
  const others = existingTags.flatMap(other => {
    try { return other === tag ? [] : [parseTag(other)] } catch { return [] }
  })
  const stable = others.filter(other => !other.prerelease.length)
  const prerelease = current.prerelease.length > 0
  const newer = (other: Version) => compareVersions(other, current) > 0
  const tags = [current.version]
  let latest = false
  if (!prerelease) {
    if (!stable.some(other => other.major === current.major && other.minor === current.minor && newer(other))) {
      tags.push(`${current.major}.${current.minor}`)
    }
    latest = !stable.some(newer)
    if (latest) tags.push('latest')
  }
  // Upgrade notes cover changes since the previous release; a release skips its own pre-releases.
  const previous = (prerelease ? others : stable).filter(other => compareVersions(other, current) < 0)
    .sort(compareVersions).at(-1)?.tag
  return { version: current.version, prerelease, tags, latest, ...(previous ? { previous } : {}) }
}

if (import.meta.main) {
  const tag = process.argv[2] ?? ''
  const existing = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const plan = planRelease(tag, existing)
  // GITHUB_OUTPUT lines.
  console.log(`version=${plan.version}`)
  console.log(`prerelease=${plan.prerelease}`)
  console.log(`tags=${plan.tags.join(',')}`)
  console.log(`latest=${plan.latest}`)
  console.log(`previous=${plan.previous ?? ''}`)
}
