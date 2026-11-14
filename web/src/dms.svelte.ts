import { createSubscriber } from 'svelte/reactivity'
import type { Dms } from './dms'

export function dmsAdapter(dms: Dms) {
  const subscribe = createSubscriber(update => dms.subscribe(update))
  return {
    get state() { subscribe(); return dms.get() },
    browse: () => dms.browse(),
    refresh: () => dms.refresh(),
    open: (member: string, renew = false) => dms.open(member, renew),
    select: (id: string) => dms.select(id),
  }
}
export type DmsAdapter = ReturnType<typeof dmsAdapter>
