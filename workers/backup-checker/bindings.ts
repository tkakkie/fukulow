// Minimal structural interfaces for the APIs used here; no Node compatibility.
export interface R2Object {
  key: string; size: number; uploaded: Date; checksums?: { sha256?: ArrayBuffer }
}
export interface R2List {
  objects: R2Object[]; truncated: boolean; cursor?: string; delimitedPrefixes?: string[]
}
export interface R2Listing { list(options: { limit: number; cursor?: string }): Promise<R2List> }
export interface R2Binding extends R2Listing {
  head(key: string): Promise<R2Object | null>
  get(key: string): Promise<(R2Object & { arrayBuffer(): Promise<ArrayBuffer> }) | null>
  delete(key: string): Promise<void>
}
export interface StorageTransaction {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
}
export interface DurableStorage extends StorageTransaction {
  transaction<T>(body: (tx: StorageTransaction) => Promise<T>): Promise<T>
}
export interface Env {
  BACKUPS: R2Binding
  IMAGES: R2Listing
  CHECKER: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
  DISCORD_WEBHOOK_URL: string
  ANALYTICS_URL: string
  ANALYTICS_TOKEN: string
  ANALYTICS_ACCOUNT: string
}
export type Guard = () => Promise<void>
