import { randomUUID } from 'node:crypto'
import { checksum, sha256 } from './backup-r2-model.ts'
import { listObjects } from './backup-r2-list.ts'
import { curlRunner, executeCurl, readPrivateFile, type Runner } from './backup-r2.ts'
import { accountUsage, analyticsClient, validUsage, type UsageClient, type UsageState } from './backup-r2-usage.ts'

// Mutate only the signing secret, retaining the configured access ID. The
// supported private curl config uses: user = "access-id:signing-secret".
export async function wrongSignatureRunner(configFile: string, baseUrl: string, execute = executeCurl) {
  const contents = await readPrivateFile(configFile)
  const access = /^\s*user\s*=\s*"([^":\r\n\\]+):[^"\r\n]*"\s*$/m.exec(contents)?.[1]
  if (!access) throw new Error('Verification configuration failed')
  return curlRunner(configFile, baseUrl, (args, input) =>
    execute(args, input + `user = "${access}:${randomUUID()}"\n`))
}
const refused = (status: number) => status === 403 || status === 409 || status === 412
export async function verifyProvider(options: {
  run: Runner; wrongSignature: Runner; usage?: UsageClient; now?: () => number
  report?: (line: string) => void
}) {
  const report = options.report ?? console.log, results: boolean[] = [], id = randomUUID()
  const prefix = `verification/${id}/`, locked = `backups/verification-${id}/probe`
  const body = Buffer.from(randomUUID()), hex = sha256(body)
  const headers = { 'x-amz-content-sha256': hex, 'x-amz-checksum-sha256': checksum(hex) }
  const probes = [0, 1, 2].map(i => prefix + i)
  const check = async (name: string, work: () => Promise<'PASS' | 'FAIL' | 'UNSUPPORTED'>) => {
    let result: 'PASS' | 'FAIL' | 'UNSUPPORTED' = 'FAIL'
    try { result = await work() } catch { /* Never expose response bodies or errors. */ }
    report(`${result} ${name}`); results.push(result === 'PASS' || result === 'UNSUPPORTED')
  }
  const run = options.run
  await check('sigv4', async () => {
    const good = await run({ method: 'GET', key: '', headers: {}, query: { 'list-type': '2', 'max-keys': '1', prefix } })
    const bad = await options.wrongSignature({ method: 'GET', key: '', headers: {}, query: { 'list-type': '2', 'max-keys': '1', prefix } })
    return good.status === 200 && (bad.status === 403 || bad.status === 401) ? 'PASS' : 'FAIL'
  })
  await check('checksum-readback', async () => {
    for (const key of probes) {
      const put = await run({ method: 'PUT', key, headers, body })
      if (put.status < 200 || put.status >= 300) return 'FAIL'
    }
    const bad = await run({ method: 'PUT', key: prefix + 'bad-checksum', headers: { ...headers, 'x-amz-checksum-sha256': checksum(sha256('wrong')) }, body })
    const head = await run({ method: 'HEAD', key: probes[0], headers: { 'x-amz-checksum-mode': 'ENABLED' } })
    const get = await run({ method: 'GET', key: probes[0], headers: {} })
    return bad.status === 400 && head.status === 200 && Number(head.headers['content-length']) === body.length &&
      head.headers['x-amz-checksum-sha256'] === checksum(hex) && get.status === 200 && get.body.equals(body) && sha256(get.body) === hex ? 'PASS' : 'FAIL'
  })
  await check('pagination', async () => {
    let pages = 0
    const listed = await listObjects(async request => { pages++; return run(request) }, 10_000, 1, prefix)
    return pages >= 3 && probes.every(key => listed.some(o => o.key === key)) ? 'PASS' : 'FAIL'
  })
  await check('conditional-delete', async () => {
    const response = await run({ method: 'DELETE', key: probes[0], headers: { 'if-match': '"verification-nonmatching"' } })
    const head = await run({ method: 'HEAD', key: probes[0], headers: { 'x-amz-checksum-mode': 'ENABLED' } })
    if (response.status === 412 && head.status === 200) return 'PASS'
    return (response.status === 200 || response.status === 204) && head.status === 404 ? 'UNSUPPORTED' : 'FAIL'
  })
  await check('bucket-lock-probe-retained', async () => {
    const put = await run({ method: 'PUT', key: locked, headers, body })
    if (put.status < 200 || put.status >= 300) return 'FAIL'
    const overwrite = await run({ method: 'PUT', key: locked, headers, body })
    const deletion = await run({ method: 'DELETE', key: locked, headers: {} })
    const get = await run({ method: 'GET', key: locked, headers: {} })
    return refused(overwrite.status) && refused(deletion.status) && get.status === 200 && get.body.equals(body) ? 'PASS' : 'FAIL'
  })
  if (options.usage) await check('analytics', () => fullMonthUsage(options.usage!, (options.now ?? Date.now)()))
  // Only disposable unlocked probes are cleaned up. Locked probes remain until
  // the operator removes them after expiry; inventory counts their capacity.
  await check('probe-cleanup', async () => {
    for (const key of [...probes, prefix + 'bad-checksum']) {
      const response = await run({ method: 'DELETE', key, headers: {} })
      if (response.status !== 200 && response.status !== 204) return 'FAIL'
    }
    return 'PASS'
  })
  return results.every(Boolean)
}
// The Worker backfills a few days per hourly run; verify has no persisted
// cache, so it repeats reads on one in-memory state while the cache grows.
async function fullMonthUsage(usage: UsageClient, now: number): Promise<'PASS' | 'FAIL'> {
  const state: UsageState = {}
  for (;;) {
    const cached = Object.keys(state.usageCache?.days ?? {}).length
    try { return validUsage(await usage.read(now, state)) ? 'PASS' : 'FAIL' } catch (error) {
      if (Object.keys(state.usageCache?.days ?? {}).length === cached) throw error
    }
  }
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error()
    const config = JSON.parse(await readPrivateFile(process.argv[2]))
    const run = await curlRunner(config.curlConfigFile, config.baseUrl)
    const wrongSignature = await wrongSignatureRunner(config.curlConfigFile, config.baseUrl)
    let usage: UsageClient | undefined
    if (config.usageConfigFile) {
      const value = JSON.parse(await readPrivateFile(config.usageConfigFile))
      usage = accountUsage(await analyticsClient(value.curlConfigFile), value.account)
    }
    if (!await verifyProvider({ run, wrongSignature, usage })) process.exitCode = 1
  } catch { console.log('FAIL configuration'); process.exitCode = 1 }
}
