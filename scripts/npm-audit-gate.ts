import { spawnSync } from 'node:child_process'

export type Exception = {
  id: string, package: string, expires: string, issue: string, reason: string,
}

export const exceptions: readonly Exception[] = [{
  id: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  expires: '2026-12-18',
  issue: '#565',
  reason: 'Build/test tooling only, not in the shipped bundle, no patched version.',
}]

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAudit(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    throw new Error('npm audit produced no parsable JSON')
  }
}

// Staleness is evaluated across all prefixes, including prefixes with no findings.
export function evaluate(audits: readonly unknown[], allowed: readonly Exception[], today: string) {
  const findings: string[] = []
  const errors: string[] = []
  const matched = new Set<Exception>()
  if (audits.length === 0) errors.push('No npm audit reports supplied')
  for (const exception of allowed) {
    if (today > exception.expires) {
      errors.push(`${exception.id} (${exception.package}) expired ${exception.expires}; re-decide in ${exception.issue}`)
    }
  }
  for (const audit of audits) {
    if (!object(audit) || !object(audit.vulnerabilities) || audit.error) {
      errors.push('Invalid npm audit report: expected vulnerabilities and no audit error')
      continue
    }
    for (const [name, node] of Object.entries(audit.vulnerabilities)) {
      if (!object(node) || !Array.isArray(node.via)) {
        errors.push(`Invalid npm audit vulnerability node: ${name}`)
        continue
      }
      for (const advisory of node.via) {
        if (typeof advisory === 'string') continue
        if (!object(advisory) || typeof advisory.name !== 'string'
          || !['info', 'low', 'moderate', 'high', 'critical'].includes(String(advisory.severity))) {
          errors.push(`Invalid npm audit advisory: ${name}`)
          continue
        }
        const id = typeof advisory.url === 'string'
          ? advisory.url.match(/^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\/?$/)?.[1]
          : undefined
        const exception = allowed.find(entry => entry.id === id && entry.package === advisory.name)
        findings.push(`${advisory.name} ${id ?? '(no GHSA URL)'} ${advisory.severity}`
          + (exception ? ` — covered by ${exception.issue}, expires ${exception.expires}: ${exception.reason}` : ''))
        if (exception) matched.add(exception)
        if ((advisory.severity === 'high' || advisory.severity === 'critical') && !exception) {
          errors.push(`Unexcepted ${advisory.severity} advisory: ${advisory.name} ${id ?? '(no GHSA URL)'}`)
        }
      }
    }
    for (const exception of allowed) {
      const node = audit.vulnerabilities[exception.package]
      if (!object(node)) continue
      const fix = node.fixAvailable
      if (fix === true || (object(fix) && fix.isSemVerMajor === false)) {
        errors.push(`${exception.id} (${exception.package}) has a non-major fix; update and remove the exception (${exception.issue})`)
      }
    }
  }
  for (const exception of allowed) {
    if (!matched.has(exception)) {
      errors.push(`${exception.id} (${exception.package}) is stale across audited prefixes; remove the stale exception (${exception.issue})`)
    }
  }
  return { findings, errors, ok: errors.length === 0 }
}

if (import.meta.main) {
  try {
    const prefixes = process.argv.slice(2)
    if (prefixes.length === 0) throw new Error('Usage: node scripts/npm-audit-gate.ts <prefix> [prefix ...]')
    const audits = prefixes.map(prefix => {
      const result = spawnSync('npm', ['--prefix', prefix, 'audit', '--json'], { encoding: 'utf8' })
      if (result.error) throw result.error
      if (result.signal || (result.status !== 0 && result.status !== 1)) {
        throw new Error(`npm audit failed for ${prefix} (status ${result.status}, signal ${result.signal})`)
      }
      return parseAudit(result.stdout)
    })
    const result = evaluate(audits, exceptions, new Date().toISOString().slice(0, 10))
    for (const finding of result.findings) console.log(finding)
    for (const error of result.errors) console.error(error)
    console.log(`npm audit gate: ${result.ok ? 'PASS' : 'FAIL'} (${prefixes.join(', ')})`)
    process.exitCode = result.ok ? 0 : 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
