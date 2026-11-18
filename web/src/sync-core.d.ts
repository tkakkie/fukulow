declare module '#sync-core' {
  export function createReplyCountCore(): import('./reply-count-core').CountCore
  export function initCore(): Promise<void>
  export function createCore(selfId: string): import('./protocol-types').SyncCore
}
