import type { Dm } from './api-schema'

export const dm = (id: string, overrides: Partial<Dm> = {}): Dm => ({ id, kind: 'dm', peer: { id: `peer-${id}`, name: `Peer ${id}`, active: true },
  capabilities: { can_add_members: { allowed: false }, can_remove_members: { allowed: false }, can_manage_managers: { allowed: false }, can_leave: { allowed: false } },
  as_of_seq: 10, read_seq: 2, main_unread_count: 8, unread_count: 8, mention_unread_count: 0, ...overrides })
