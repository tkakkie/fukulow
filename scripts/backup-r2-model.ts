import { createHash } from 'node:crypto'

export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
export * from './backup-r2-inventory.ts'
