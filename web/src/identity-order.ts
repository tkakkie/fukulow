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
  return incoming.id !== held.id ? (incoming.created_seq > held.created_seq ? incoming : held)
    : mergeMessageState(held, incoming)
}

/** A value-equal canonical copy may still be newer than a cached directory rename. */
export function newerMentionResponse(held: readonly import('./api').Message[], message: import('./api').Message): boolean {
  if (!message.mentions?.length) return false
  let lo = 0, hi = held.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (held[mid].created_seq < message.created_seq) lo = mid + 1
    else hi = mid
  }
  const old = held[lo]
  return old?.id === message.id && identityOrder(message.mentions) > identityOrder(old.mentions ?? old)
}

/** Complete Message states replace only at a higher version; names have independent response freshness. */
export function mergeMessageState(held: import('./api').Message | undefined, incoming: import('./api').Message): import('./api').Message {
  if (held === incoming) return held
  if (held && incoming.version < held.version) return held
  if (held && incoming.version === held.version) {
    if (held.deleted || !incoming.mentions || identityOrder(incoming.mentions) < identityOrder(held.mentions ?? held)) return held
    if (held.mentions === incoming.mentions || (!held.mentions?.length && !incoming.mentions.length)) return held
    return { ...held, mentions: incoming.mentions }
  }
  if (!incoming.deleted) return incoming
  const { body: _body, mentions: _mentions, ...tombstone } = incoming
  return tombstone
}

export function knownMessageState(channel: Pick<import('./protocol-types').ChannelState, 'versions' | 'messages'> | undefined,
  held: import('./api').Message | undefined, incoming: import('./api').Message): import('./api').Message | undefined {
  const version = channel?.versions[incoming.id]
  if (version && (version[0] > incoming.version || (version[1] && !incoming.deleted))) {
    return channel?.messages.find(m => m.id === incoming.id && m.version >= version[0]) ??
      (held && held.version >= version[0] ? held : undefined)
  }
  return mergeMessageState(held, incoming)
}
