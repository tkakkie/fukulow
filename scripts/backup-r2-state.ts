import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { privateDirectory, syncDirectory } from './backup-safety.ts'

import { decodeState, validState, type StateStore } from './backup-checker-state.ts'
export function fileStateStore(path: string, sync = syncDirectory): StateStore {
  const directory = dirname(path)
  return {
    async load() {
      privateDirectory(directory)
      try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > 16_384) throw new Error('Invalid state file')
          const parsed = JSON.parse(await handle.readFile('utf8'))
          return decodeState(parsed)
        } finally { await handle.close() }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { state: { sentAlerts: [] }, warning: 'state-missing' }
        return { state: { sentAlerts: [] }, warning: 'state-corrupt' }
      }
    },
    async save(state) {
      privateDirectory(directory)
      if (!validState(state)) throw new Error('Invalid checker state')
      // Refuse symlinks and unsafe files even though rename would replace them.
      try {
        const info = await lstat(path)
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw new Error('Unsafe state destination')
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw new Error('State persistence failed')
      }
      const temporary = join(directory, `.checker-state-${randomUUID()}`)
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify({ version: 1, state })); await handle.sync() } finally { await handle.close() }
        await rename(temporary, path)
        sync(directory)
      } catch { throw new Error('State persistence failed') }
      finally { await rm(temporary, { force: true }) }
    },
  }
}
