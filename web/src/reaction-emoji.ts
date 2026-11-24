import catalog from '../../contract/reactions/emoji.json'

type ReactionEmoji = Readonly<{ emoji: string; label: string }>

export const reactionEmoji: readonly ReactionEmoji[] = catalog.emoji
