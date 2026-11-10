/** Client policy, also used by the reconnect-storm load scenario. Random is in [0, 1). */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)))
}
