declare module '#sync-core' {
  export function initCore(): Promise<void>
  export function createCore(selfId: string): import('./protocol-types').SyncCore
}
