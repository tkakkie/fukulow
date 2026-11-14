import type { Member, Message } from './api'

const tokenPattern = /@\{member:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}/g
export type MentionName = (id: string, fallback: string, mentions: Message['mentions']) => string

/** Never consult display identities until the server's persisted set accepts the token. */
export function mentionText(body: string, mentions: Message['mentions'], name?: MentionName): string {
  const accepted = new Map(mentions.map(target => [target.member_id, target.name]))
  return body.replace(tokenPattern, (token, id: string) => {
    const fallback = accepted.get(id)
    return fallback === undefined ? token : `@${name?.(id, fallback, mentions) ?? fallback}`
  })
}

export function mentionQuery(body: string, caret: number): { start: number; end: number; query: string } | null {
  const prefix = body.slice(0, caret)
  const match = /(?:^|\s)@([^\s@{}]*)$/.exec(prefix)
  return match ? { start: prefix.lastIndexOf('@'), end: caret, query: match[1] } : null
}

export function mentionCandidates(members: readonly Member[], query: string): Member[] {
  const needle = query.toLocaleLowerCase('ja')
  return members.filter(member => member.name.toLocaleLowerCase('ja').includes(needle)).slice(0, 10)
}

export function insertMention(body: string, range: { start: number; end: number }, member: Member) {
  const token = `@{member:${member.id}} `
  return { body: body.slice(0, range.start) + token + body.slice(range.end), caret: range.start + token.length }
}
