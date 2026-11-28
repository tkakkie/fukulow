import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileDigest } from './backup-r2-publish.ts'

export interface Request { method: 'PUT' | 'HEAD' | 'GET' | 'DELETE'; key: string; headers: Record<string, string>; query?: Record<string, string>; body?: Buffer; digestOnly?: boolean }
export interface Response { status: number; headers: Record<string, string>; body: Buffer; digest?: { sha256: string; size: number } }
export type Runner = (request: Request) => Promise<Response>

// Config contains credentials only outside the checkout; curl diagnostics never escape.
export async function privateCurlConfig(configFile: string): Promise<string> {
  try {
    const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
    const path = resolve(configFile), info = await lstat(path)
    const canonical = await realpath(path)
    if (canonical.startsWith(await realpath(root) + sep) || !info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('Private external curl config required')
    return path
  } catch { throw new Error('Private external curl config required') }
}
// Operator JSON and recipient reads share the curl config privacy contract, with
// descriptor checks so FIFOs and symlink replacements cannot block or escape it.
export async function readPrivateFile(configFile: string): Promise<string> {
  const path = await privateCurlConfig(configFile)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 65_536) throw new Error('Private external config required')
    return await handle.readFile('utf8')
  } finally { await handle.close() }
}
export async function curlRunner(configFile: string, baseUrl: string, execute = executeCurl): Promise<Runner> {
  const path = await privateCurlConfig(configFile)
  if (!/^https:\/\//.test(baseUrl) || /[\r\n"\\]/.test(baseUrl)) throw new Error('Invalid transport configuration')
  return async request => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-curl-'))
    try {
      const headersFile = join(directory, 'headers'), bodyFile = join(directory, 'body')
      const args = ['--disable', '--config', path, '--aws-sigv4', 'aws:amz:auto:s3', '--silent', '--retry', '3', '--retry-all-errors', '--max-time', '120', '--retry-max-time', '480', '--dump-header', headersFile, '--output', bodyFile, '--request', request.method]
      if (request.method === 'HEAD') args.push('--head')
      for (const [key, value] of Object.entries(request.headers)) args.push('--header', `${key}: ${value}`)
      // URL is supplied via stdin config, so private endpoints never enter argv.
      const query = request.query ? '?' + new URLSearchParams(request.query).toString() : ''
      const input = `url = "${baseUrl.replace(/\/$/, '')}/${request.key.split('/').map(encodeURIComponent).join('/')}${query}"\n`
      if (request.body) {
        const { writeFile } = await import('node:fs/promises')
        const upload = join(directory, 'upload')
        await writeFile(upload, request.body, { mode: 0o600 })
        args.push('--data-binary', '@' + upload)
      }
      args.push('--config', '-')
      await execute(args, input)
      const raw = await readFile(headersFile, 'utf8')
      const block = raw.trim().split(/\r?\n\r?\n/).at(-1)!
      const headers = Object.fromEntries(block.split(/\r?\n/).slice(1).map(line => { const i = line.indexOf(':'); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()] }))
      return { status: Number(block.split(' ')[1]), headers,
        body: request.digestOnly ? Buffer.alloc(0) : await readFile(bodyFile),
        ...(request.digestOnly ? { digest: await fileDigest(bodyFile) } : {}) }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
}

export async function executeCurl(args: string[], input: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', () => reject(new Error('Transport failed')))
    child.on('close', code => code === 0 ? accept() : reject(new Error('Transport failed')))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
