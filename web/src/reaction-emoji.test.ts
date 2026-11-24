import { expect, it } from 'vitest'
import catalog from '../../contract/reactions/emoji.json'
import { reactionEmoji } from './reaction-emoji'

it('exports the Reaction emoji in contract order without duplicates', () => {
  expect(reactionEmoji).toEqual(catalog.emoji)
  expect(new Set(reactionEmoji.map(({ emoji }) => emoji)).size).toBe(catalog.emoji.length)
})
