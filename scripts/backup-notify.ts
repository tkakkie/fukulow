import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { executeCurl, readPrivateFile } from './backup-r2.ts'
import { notificationText } from './backup-notification-text.ts'
import { defaultRetryDelayMs, discordAttempts, discordOutcome, retryAfterDelayMs } from './backup-discord-retry.ts'
export { notificationText } from './backup-notification-text.ts'

export async function discordNotifier(configFile: string, execute = executeCurl,
  pause: (ms: number) => Promise<unknown> = setTimeout) {
  let url: string
  try {
    const config = JSON.parse(await readPrivateFile(configFile))
    const parsed = new URL(config.webhookUrl)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || /[\r\n"\\]/.test(config.webhookUrl)) throw new Error()
    url = config.webhookUrl
  } catch { throw new Error('Notification failed category=configuration') }
  return async (event: string): Promise<void> => {
    let text: string
    try { text = notificationText(event) } catch { throw new Error('Notification failed category=event') }
    let directory: string | undefined
    try {
      directory = await mkdtemp(join(tmpdir(), 'backup-notify-'))
      for (let attempt = 0; attempt < discordAttempts; attempt++) {
        let status = 0, retryAfter = defaultRetryDelayMs
        try {
          const headers = join(directory, 'headers')
          await execute(['--disable', '--silent', '--retry', '0', '--max-time', '30', '--request', 'POST',
            '--header', 'content-type: application/json', '--data-binary', JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
            '--dump-header', headers, '--output', '/dev/null', '--config', '-'], `url = "${url}"\n`)
          const block = (await readFile(headers, 'utf8')).trim().split(/\r?\n\r?\n/).at(-1)!
          status = Number(block.split(' ')[1])
          retryAfter = retryAfterDelayMs(/^retry-after:\s*(.+)$/im.exec(block)?.[1]?.trim(), Date.now)
        } catch { /* Network errors have the same fixed retry policy. */ }
        const outcome = discordOutcome(status)
        if (outcome === 'delivered') return
        if (outcome !== 'retry') throw new Error(`Notification failed category=${outcome}`)
        if (attempt < discordAttempts - 1) await pause(retryAfter)
      }
      throw new Error('Notification failed category=unavailable')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (/^Notification failed category=(event|rejected|response|unavailable)$/.test(message)) throw new Error(message)
      throw new Error('Notification failed category=unavailable')
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }) }
      catch { throw new Error('Notification failed category=cleanup') }
    }
  }
}
