import { expect, it, vi } from 'vitest'
import type { Member } from './api'
import { mentionText, mentionQuery, mentionCandidates, insertMention } from './mentions'
import { createAuthors } from './authors'
import { rememberIdentityResponse } from './identity-order'
const id = '123e4567-e89b-12d3-a456-426614174000'
const rejected = '123e4567-e89b-12d3-a456-426614174001'
const token = (who: string) => `@{member:${who}}`
const member = (who: string, name: string): Member => ({ id: who, name, role: 'member' })
it('Mention rendering resolves only exact accepted tokens and never looks up rejected identities', () => {
  const name = vi.fn((_id: string) => '現在の名前')
  const text = `${token(id)}${token(id)} ${token(rejected)} ${token(id.toUpperCase())} @{member: ${id}} @{member:${id} @all @channel <script>`
  expect(mentionText(text, [{ member_id: id, name: '以前の名前' }], name)).toBe(`@現在の名前@現在の名前 ${token(rejected)} ${token(id.toUpperCase())} @{member: ${id}} @{member:${id} @all @channel <script>`)
  expect(name).toHaveBeenCalledTimes(2)
  expect(name.mock.calls.every(args => args[0] === id)).toBe(true)
  expect(mentionText(text, [], name)).toBe(text)
})
it('Mention names follow newer authorized directory identities or newer Message responses for a non-author', () => {
  const authors = createAuthors('org', vi.fn(), vi.fn())
  const first = [{ member_id: id, name: 'Message name' }]
  rememberIdentityResponse(first)
  authors.replaceMembers([member(id, 'Directory rename')])
  expect(mentionText(token(id), first, authors.mentionName)).toBe('@Directory rename')
  const refetched = [{ member_id: id, name: 'Renamed after deactivation' }]
  rememberIdentityResponse(refetched)
  expect(mentionText(token(id), refetched, authors.mentionName)).toBe('@Renamed after deactivation')
  authors.replaceMembers([])
  expect(mentionText(token(id), refetched, authors.mentionName)).toBe('@Renamed after deactivation')
  authors.replaceMembers([member(rejected, 'Later granted')])
  expect(mentionText(token(rejected), refetched, authors.mentionName)).toBe(token(rejected))
  authors.close()
})
it('Mention autocomplete filters only its authorized directory and inserts the stable token at the caret', () => {
  const members = [member(id, '田中'), member(rejected, '鈴木')]
  expect(mentionCandidates(members, '田')).toEqual([members[0]])
  expect(mentionCandidates([], '田')).toEqual([])
  const body = '本文 @田 続き', caret = '本文 @田'.length
  expect(mentionQuery(body, caret)).toEqual({ start: 3, end: 5, query: '田' })
  expect(insertMention(body, mentionQuery(body, caret)!, members[0])).toEqual({ body: `本文 ${token(id)}  続き`, caret: 3 + token(id).length + 1 })
  for (const text of ['mail@example', token(id), '@{member:', '@all ']) expect(mentionQuery(text, text.length)).toBeNull()
  expect(mentionCandidates(Array.from({ length: 20 }, (_, n) => member(String(n), '候補')), '')).toHaveLength(10)
})

it('Mention value-equal canonical refresh supersedes an older directory rename without changing the accepted set', async () => {
  const { unreadClient, msg, flush } = await import('./unread-test-helpers')
  const c = unreadClient(); await c.boot()
  const authors = createAuthors('org', vi.fn(), vi.fn())
  const message = { ...msg(4), body: token(id), mentions: [{ member_id: id, name: 'Original' }] }
  c.event(message); await flush()
  authors.replaceMembers([member(id, 'Renamed')])
  const held = () => c.sync.get().channels.A.messages.find(m => m.seq === 4)!
  expect(mentionText(held().body, held().mentions, authors.mentionName)).toBe('@Renamed')
  c.event({ ...message, mentions: [{ member_id: id, name: 'Original' }] }); await flush()
  expect(mentionText(held().body, held().mentions, authors.mentionName)).toBe('@Original')
  expect(held().mentions.map(m => m.member_id)).toEqual([id])
  authors.close(); await c.sync.close()
})
