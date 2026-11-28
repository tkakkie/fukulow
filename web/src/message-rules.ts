/** Client-side input rules matching the server's Message/Topic API contract. */

/** Max Message body length in Unicode scalar values (API rule; a test compares it to openapi.json). */
export const MESSAGE_BODY_MAX = 4000

/** Max Topic name length in Unicode scalar values (API rule; a test compares it to openapi.json). */
export const TOPIC_NAME_MAX = 60

/** Channel-scoped ASCII case fold matching the server's `to_ascii_lowercase()` Topic identity. */
export const foldTopicName = (name: string): string => name.replace(/[A-Z]/g, ch => ch.toLowerCase())

/** Japanese message when the Message body violates API scalar/NUL rules, else null. */
export function messageBodyError(body: string): string | null {
  if (body.includes('\0')) return 'メッセージにNUL文字は含められません。'
  let count = 0
  for (const ch of body) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0xd800 && cp <= 0xdfff) return 'メッセージに使用できない文字が含まれています。'
    if (++count > MESSAGE_BODY_MAX) return `メッセージは${MESSAGE_BODY_MAX}文字以内にしてください。`
  }
  return null
}

/** Japanese message when a Topic name violates API scalar/NUL/whitespace rules, else null. */
export function topicNameError(name: string): string | null {
  if (name.includes('\0')) return 'トピック名にNUL文字は含められません。'
  if (name.length === 0 || /^\p{White_Space}|\p{White_Space}$/u.test(name)) {
    return `トピック名の前後に空白を入れず、1〜${TOPIC_NAME_MAX}文字にしてください。`
  }
  let count = 0
  for (const ch of name) {
    const cp = ch.codePointAt(0)!
    if (cp >= 0xd800 && cp <= 0xdfff) return 'トピック名に使用できない文字が含まれています。'
    if (++count > TOPIC_NAME_MAX) return `トピック名は${TOPIC_NAME_MAX}文字以内にしてください。`
  }
  return null
}
