export interface OperationUsage { classA: number; classB: number }
export interface UsageClient { read(now: number): Promise<OperationUsage> }
export interface AnalyticsClient {
  query(request: { query: string; variables: Record<string, string> }): Promise<unknown>
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
// day of the current billing month; never substitute this process's counters.
// Authentication and endpoint configuration belong to the injected private client.
export function accountUsage(client: AnalyticsClient, account: string): UsageClient {
  return { async read(now) {
    try {
      if (!account || !Number.isFinite(now)) throw new Error('Missing usage configuration')
      const current = new Date(now), start = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1)
      let classATotal = 0, classBTotal = 0
      for (let from = start; from < now; from += 86_400_000) {
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
      }
      // An empty time range provides no provider evidence, including at midnight.
      if (now === start || !Number.isSafeInteger(classATotal) || !Number.isSafeInteger(classBTotal)) throw new Error('Unknown usage')
      return { classA: classATotal, classB: classBTotal }
    } catch { throw new Error('Account operation usage unavailable') }
  } }
}
export function validUsage(value: unknown): value is OperationUsage {
  return !!value && typeof value === 'object' && 'classA' in value && 'classB' in value &&
    Number.isSafeInteger(value.classA) && Number(value.classA) >= 0 && Number.isSafeInteger(value.classB) && Number(value.classB) >= 0
}
