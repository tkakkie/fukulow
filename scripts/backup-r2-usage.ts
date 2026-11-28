import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeCurl, privateCurlConfig } from './backup-curl.ts'
import type { AnalyticsClient } from './backup-usage-model.ts'
// The private curl config supplies the provider GraphQL endpoint and read-only
// analytics authentication. Neither is put in arguments, tracked files or logs.
export async function analyticsClient(configFile: string, execute = executeCurl): Promise<AnalyticsClient> {
  const path = await privateCurlConfig(configFile)
  return { async query(request) {
    const directory = await mkdtemp(join(tmpdir(), 'backup-analytics-'))
    try {
      const output = join(directory, 'response')
      await execute(['--disable', '--config', path, '--silent', '--fail', '--retry', '0', '--max-time', '30',
        '--request', 'POST', '--header', 'content-type: application/json', '--data-binary', '@-', '--output', output], JSON.stringify(request))
      return JSON.parse(await readFile(output, 'utf8')) as unknown
    } catch { throw new Error('Account operation usage unavailable') }
    finally { await rm(directory, { recursive: true, force: true }) }
  } }
}
