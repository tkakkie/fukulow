// Temporary SYNC_CORE=ts rollback counterpart to client-core/src/reply_counts.rs (#467).
import type { CountCore, CountTicket, CountView } from './reply-count-core'
type Root = { generation: number; baseline?: { watermark: number; count: number }; floor: number; evidence: Map<string, number>; pending: boolean }
export function createReplyCountCore(): CountCore {
  const roots = new Map<string, Root>()
  let next = 0
  const fresh = (): Root => ({ generation: ++next, floor: 0, evidence: new Map(), pending: false })
  const invalidate = (r: Root, floor: number) => {
    r.generation = ++next; r.baseline = undefined; r.pending = false; r.floor = Math.max(r.floor, floor)
    for (const [id, seq] of r.evidence) if (seq <= r.floor) r.evidence.delete(id)
  }
  const ticket = ([root, r]: [string, Root]): CountTicket => ({ root, generation: r.generation })
  const view = (): CountView => ({
    counts: Object.fromEntries([...roots].map(([id, r]) => [id, r.baseline ? r.baseline.count + r.evidence.size : null])),
    needed: [...roots].filter(([, r]) => !r.baseline && !r.pending).map(ticket), tickets: [...roots].map(ticket),
  })
  return {
    free: () => roots.clear(),
    step(input) {
      if (input.type === 'track') {
        const wanted = new Set(input.roots)
        for (const id of roots.keys()) if (!wanted.has(id)) roots.delete(id)
        for (const id of wanted) if (!roots.has(id)) roots.set(id, fresh())
      } else if (input.type === 'reset') {
        for (const id of roots.keys()) roots.set(id, fresh())
      } else if (input.type === 'begin' || input.type === 'failed') {
        for (const t of input.tickets) { const r = roots.get(t.root); if (r?.generation === t.generation) r.pending = input.type === 'begin' }
      } else if (input.type === 'install') {
        const r = roots.get(input.ticket.root)
        if (r?.generation === input.ticket.generation) {
          r.pending = false
          if (input.watermark >= r.floor && input.watermark >= (r.baseline?.watermark ?? 0)) {
            r.baseline = { watermark: input.watermark, count: input.count }
            for (const [id, seq] of r.evidence) if (seq <= input.watermark) r.evidence.delete(id)
          }
        }
      } else {
        const r = roots.get(input.root)
        if (r && input.seq > r.floor && input.seq > (r.baseline?.watermark ?? 0)) {
          if (input.type === 'invalidate') invalidate(r, input.seq)
          else if (!r.evidence.has(input.id)) r.evidence.set(input.id, input.seq)
        }
      }
      while ([...roots.values()].reduce((n, r) => n + r.evidence.size, 0) > 400) {
        const oldest = [...roots.values()].filter(r => r.evidence.size).sort((a, b) => Math.min(...a.evidence.values()) - Math.min(...b.evidence.values()))[0]
        invalidate(oldest, Math.max(...oldest.evidence.values()))
      }
      return view()
    },
  }
}
