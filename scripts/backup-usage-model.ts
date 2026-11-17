export interface OperationUsage { classA: number; classB: number }
export interface UsageClient { read(now: number, state?: UsageState): Promise<OperationUsage> }
export interface AnalyticsClient {
  query(request: { query: string; variables: Record<string, string> }): Promise<unknown>
}
export interface UsageCache { month: string; days: Record<string, OperationUsage> }
export interface UsageState { usageCache?: UsageCache }
export const analyticsLag = 6 * 60 * 60 * 1000
export const uncachedDaysPerRun = 3
export function validUsageCache(value: unknown): value is UsageCache {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'days,month') return false
  const cache = value as UsageCache
  if (typeof cache.month !== 'string' || !/^\d{4}-\d\d$/.test(cache.month) ||
    !Number.isFinite(Date.parse(cache.month + '-01')) || new Date(cache.month + '-01').toISOString().slice(0, 7) !== cache.month ||
    !cache.days || typeof cache.days !== 'object' || Array.isArray(cache.days)) return false
  return Object.entries(cache.days).every(([date, usage]) => date.startsWith(cache.month + '-') && /^\d{4}-\d\d-\d\d$/.test(date) &&
    Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date && validUsage(usage) && Object.keys(usage).sort().join() === 'classA,classB')
}
const classA = new Set(['ListBuckets', 'ListObjects', 'ListObjectsV2', 'ListMultipartUploads', 'ListParts', 'PutBucket', 'PutBucketCors', 'PutBucketLifecycleConfiguration', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'UploadPart', 'UploadPartCopy'])
const classB = new Set(['HeadBucket', 'HeadObject', 'GetBucketCors', 'GetBucketLifecycleConfiguration', 'GetBucketLocation', 'GetObject', 'UsageSummary'])
const free = new Set(['DeleteObject', 'DeleteObjects', 'DeleteBucket', 'AbortMultipartUpload'])
const query = `query Operations($account: String!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    r2OperationsAdaptiveGroups(limit: 1000, groupBy: [actionType], filter: {datetime_geq: $start, datetime_lt: $end}) {
      dimensions { actionType } sum { requests }
    }
  } }
}`

// No bucket filter: free operation allowances are account-wide. Query each UTC
// day separately; closed days are cached only after the analytics lag margin.
// Authentication and endpoint configuration belong to the injected private client.
export function accountUsage(client: AnalyticsClient, account: string): UsageClient {
  return { async read(now, state = {}) {
    try {
      if (!account || !Number.isFinite(now)) throw new Error('Missing usage configuration')
      const current = new Date(now), start = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1)
      const today = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate())
      const month = current.toISOString().slice(0, 7)
      if (state.usageCache !== undefined && !validUsageCache(state.usageCache)) throw new Error('Invalid usage cache')
      if (state.usageCache?.month !== month) state.usageCache = { month, days: {} }
      const cache = state.usageCache
      if (Object.keys(cache.days).some(date => Date.parse(date) + 86_400_000 + analyticsLag > now)) throw new Error('Unclosed cached day')
      const totals: OperationUsage[] = Object.values(cache.days)
      const missing: number[] = []
      for (let from = start; from < today; from += 86_400_000) {
        if (!cache.days[new Date(from).toISOString().slice(0, 10)]) missing.push(from)
      }
      const ranges = missing.slice(0, uncachedDaysPerRun)
      if (now > today) ranges.push(today)
      for (const from of ranges) {
        let classATotal = 0, classBTotal = 0
        const to = Math.min(from + 86_400_000, now)
        const response = await client.query({ query, variables: { account, start: new Date(from).toISOString(), end: new Date(to).toISOString() } }) as {
          errors?: unknown; data?: { viewer?: { accounts?: { r2OperationsAdaptiveGroups?: { dimensions?: { actionType?: string }; sum?: { requests?: number } }[] }[] } }
        }
        const accounts = response?.data?.viewer?.accounts, groups = accounts?.[0]?.r2OperationsAdaptiveGroups
        if (response?.errors || accounts?.length !== 1 || !Array.isArray(groups) || !groups.length || groups.length >= 1000) throw new Error('Incomplete analytics')
        const seen = new Set<string>()
        for (const group of groups) {
          const action = group.dimensions?.actionType, count = group.sum?.requests
          if (!action || seen.has(action) || !Number.isSafeInteger(count) || Number(count) < 0) throw new Error('Invalid usage')
          seen.add(action)
          if (classA.has(action)) classATotal += Number(count)
          else if (classB.has(action)) classBTotal += Number(count)
          else if (!free.has(action)) throw new Error('Unknown operation')
        }
        if (!Number.isSafeInteger(classATotal) || !Number.isSafeInteger(classBTotal)) throw new Error('Unknown usage')
        const usage = { classA: classATotal, classB: classBTotal }
        totals.push(usage)
        if (to === from + 86_400_000 && now >= to + analyticsLag) cache.days[new Date(from).toISOString().slice(0, 10)] = usage
      }
      if (missing.length > uncachedDaysPerRun || now === start) throw new Error('Incomplete month')
      const result = totals.reduce((sum, usage) => ({ classA: sum.classA + usage.classA, classB: sum.classB + usage.classB }), { classA: 0, classB: 0 })
      if (!validUsage(result)) throw new Error('Unknown usage')
      return result
    } catch { throw new Error('Account operation usage unavailable') }
  } }
}
export function validUsage(value: unknown): value is OperationUsage {
  return !!value && typeof value === 'object' && 'classA' in value && 'classB' in value &&
    Number.isSafeInteger(value.classA) && Number(value.classA) >= 0 && Number.isSafeInteger(value.classB) && Number(value.classB) >= 0
}
