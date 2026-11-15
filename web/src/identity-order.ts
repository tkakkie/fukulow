// Weak keys keep response ordering metadata within the lifetime of retained payloads.
const orders = new WeakMap<object, number>()
let order = 0
export const identityOrder = (value: object): number => orders.get(value) ?? 0
export function rememberIdentityResponse(value: unknown, current = ++order): void {
  function remember(item: unknown) {
    if (!item || typeof item !== 'object' || orders.has(item)) return
    orders.set(item, current)
    for (const child of Object.values(item)) remember(child)
  }
  remember(value)
}

/** Sequence chooses the Message; response order chooses its name-bearing copy. */
export function latestMessageCopy(held: import('./api').Message, incoming: import('./api').Message): import('./api').Message {
  return incoming.seq > held.seq || (incoming.seq === held.seq && incoming.id === held.id && identityOrder(incoming.mentions) >= identityOrder(held.mentions))
    ? incoming : held
}

/** A value-equal canonical copy may still be newer than a cached directory rename. */
export function newerMentionResponse(held: readonly import('./api').Message[], message: import('./api').Message): boolean {
  if (!message.mentions.length) return false
  let lo = 0, hi = held.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (held[mid].seq < message.seq) lo = mid + 1
    else hi = mid
  }
  const old = held[lo]
  return old?.id === message.id && identityOrder(message.mentions) > identityOrder(old.mentions)
}
