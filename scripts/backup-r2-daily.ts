import { isAbsolute } from 'node:path'
import { bucketRunLock, curlRunner, dailyBackup, objectTransport, readPrivateFile, recheckNewest, type Runner } from './backup-r2.ts'
import { discordNotifier } from './backup-notify.ts'
import { acquireLocalLock, diagnostic, privateDirectory, SafeFailure, safeFailure, type RunLock } from './backup-safety.ts'

export interface DailyConfig {
  directory: string; recipientFile: string; curlConfigFile: string; baseUrl: string; notifierConfigFile: string
}
export async function readDailyConfig(path: string): Promise<DailyConfig> {
  const value = JSON.parse(await readPrivateFile(path))
  if (!value || !['directory', 'recipientFile', 'curlConfigFile', 'notifierConfigFile'].every(key =>
    typeof value[key] === 'string' && isAbsolute(value[key])) || typeof value.baseUrl !== 'string') throw new Error('Invalid operator configuration')
  return value
}
export async function runDaily(configFile: string, dependencies: {
  runner?: typeof curlRunner; notifier?: typeof discordNotifier; lockFactory?: (run: Runner) => RunLock
  daily?: typeof dailyBackup; recheck?: typeof recheckNewest; now?: () => number
} = {}) {
  let notify: ((event: string) => Promise<void>) | undefined
  try {
    const config = await readDailyConfig(configFile)
    notify = await (dependencies.notifier ?? discordNotifier)(config.notifierConfigFile)
    const run = await (dependencies.runner ?? curlRunner)(config.curlConfigFile, config.baseUrl)
    const bucket = objectTransport(run), now = dependencies.now ?? Date.now
    const recipient = (await readPrivateFile(config.recipientFile)).trim()
    await (dependencies.lockFactory ?? bucketRunLock)(run)(async () => {
      const directory = privateDirectory(config.directory)
      let release: (() => void) | undefined
      try {
        release = acquireLocalLock(directory)
        await (dependencies.daily ?? dailyBackup)({ directory, recipient, bucket, now, localLock: release,
          lock: async work => work(), notify: async event => { if (event !== 'backup-failed') await notify!(event) } })
        await (dependencies.recheck ?? recheckNewest)(bucket, now())
      } finally { release?.() }
    })
  } catch (error) {
    try { await notify?.('backup-failed') } catch { /* Fixed lifecycle failure remains observable below. */ }
    throw error instanceof SafeFailure ? error : safeFailure('publish', error)
  }
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error()
    await runDaily(process.argv[2])
    console.log('Backup passed.')
  } catch (error) {
    console.error(`Backup failed ${diagnostic(error)}. Diagnostics suppressed.`)
    process.exitCode = 1
  }
}
