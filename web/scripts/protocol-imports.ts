// Conservative source/dependency guard, not a proof of transitive purity.
// Allowlist changes require review: no runtime I/O, clock or randomness dependency belongs here.
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
// Closed inline declarations also fence features, renames and target-specific entries.
const allowed: Record<string, RegExp> = {
  'fukulow-api': /^\{path="\.\.\/api-types"\}$/,
  serde: /^\{version="[^"]+",features=\["derive","rc"\]\}$/,
  serde_json: /^"[^"]+"$/,
  uuid: /^\{version="[^"]+",features=\["serde"\]\}$/,
  'wasm-bindgen': /^\{version="=[^"]+",optional=true\}$/,
}
export function checkCoreDependencies(manifest: string): string[] {
  const errors: string[] = []
  let section = ''
  for (const line of manifest.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)
    if (header) {
      section = header[1].trim().replace(/\s*\.\s*/g, '.')
      // Dependency subtables can conceal renames/features; use inline entries only.
      if (/(?:^|[.-])dependencies\s*\./.test(section)) errors.push('dependency subtables require review')
      continue
    }
    const entry = line.replace(/#.*$/, '').trim()
    if (!entry) continue
    if (section === 'features' && entry.replace(/\s/g, '') !== 'wasm=["dep:wasm-bindgen"]') errors.push(`unapproved core feature: ${entry}`)
    if (!/(?:^|[.-])dependencies$/.test(section)) continue
    const dependency = /^([\w-]+)\s*=\s*(.*)$/.exec(entry)
    if (!dependency || !allowed[dependency[1]]?.test(dependency[2].replace(/\s/g, ''))) {
      errors.push(`unapproved core dependency declaration: ${entry}`)
    }
  }
  return errors
}
export function checkCoreSource(source: string): string[] {
  // Match identifiers even in grouped imports and aliases; intentionally conservative about comments/strings.
  const forbidden = /\b(?:fs|io|net|time|thread|process|env|random|rand|getrandom|SystemTime|Instant|new_v[147]|print|println|eprint|eprintln|dbg|extern|include|include_str|include_bytes)\b|\b(?:js_sys|web_sys|tokio|reqwest)\b/g
  return [...new Set(source.match(forbidden) ?? [])].map(name => `core source requires purity review: ${name}`)
}
export function checkRustCore(root: string): string[] {
  const errors = checkCoreDependencies(readFileSync(join(root, 'Cargo.toml'), 'utf8'))
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (entry.name.endsWith('.rs')) errors.push(...checkCoreSource(readFileSync(path, 'utf8')).map(e => `${path}: ${e}`))
    }
  }
  scan(join(root, 'src'))
  return errors
}
if (import.meta.main) {
  const errors = checkRustCore(resolve(import.meta.dirname, '../../client-core'))
  if (errors.length) { errors.forEach(e => console.error(e)); process.exit(1) }
  console.log('Rust core source/dependency purity guard OK (not a transitive proof)')
}
