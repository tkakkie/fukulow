import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { executeCurl, readPrivateFile } from './backup-r2.ts'
import { notificationText } from './backup-notification-text.ts'
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
      for (let attempt = 0; attempt < 3; attempt++) {
        let status = 0, retryAfter = 1000
        try {
          const headers = join(directory, 'headers')
          await execute(['--disable', '--silent', '--retry', '0', '--max-time', '30', '--request', 'POST',
            '--header', 'content-type: application/json', '--data-binary', JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
            '--dump-header', headers, '--output', '/dev/null', '--config', '-'], `url = "${url}"\n`)
          const block = (await readFile(headers, 'utf8')).trim().split(/\r?\n\r?\n/).at(-1)!
          status = Number(block.split(' ')[1])
          const value = /^retry-after:\s*(.+)$/im.exec(block)?.[1]?.trim()
          if (value) {
            const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
            if (Number.isFinite(delay)) retryAfter = Math.max(0, Math.min(30_000, delay))
          }
        } catch { /* Network errors have the same fixed retry policy. */ }
        if (status >= 200 && status < 300) return
        if (status >= 400 && status < 500 && status !== 429) throw new Error('Notification failed category=rejected')
        if (status !== 0 && status !== 429 && status < 500) throw new Error('Notification failed category=response')
        if (attempt < 2) await pause(retryAfter)
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
