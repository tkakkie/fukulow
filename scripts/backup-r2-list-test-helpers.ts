import type { Response } from './backup-curl.ts'
import { now } from './backup-r2-test-helpers.ts'

export const response = (body: string, status = 200): Response => ({ status, body: Buffer.from(body), headers: {} })
export const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
export const item = (key = 'object') => `<Contents><Key>${escape(key)}</Key><Size>7</Size><LastModified>${new Date(now).toISOString()}</LastModified></Contents>`
export const page = (entries: string[], truncated = false, token?: string) => `<ListBucketResult><KeyCount>${entries.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>${token === undefined ? '' : `<NextContinuationToken>${escape(token)}</NextContinuationToken>`}${entries.join('')}</ListBucketResult>`

export const scopes = ['<Prefix>backups/</Prefix>', '<StartAfter>offset</StartAfter>', '<Delimiter>/</Delimiter>',
  '<CommonPrefixes><Prefix>backups/</Prefix></CommonPrefixes>', '<EncodingType>url</EncodingType>',
  '<Prefix/><Prefix/>', '<StartAfter/><StartAfter/>', '<Delimiter/><Delimiter/>']
export const withScope = (body: string, scope: string) => body.replace('</ListBucketResult>', scope + '</ListBucketResult>')
