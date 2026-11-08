// Included by npm run check. These types come only from make api's generated schema.
import type { ClientMessage, ListMessagesQuery, Message, ServerEvent } from './api-schema'

export const latestMessagesQuery: ListMessagesQuery = {}

function assertNever(value: never): never {
  throw new Error(`Unhandled contract variant: ${JSON.stringify(value)}`)
}

export function checkClientMessage(message: ClientMessage): string {
  switch (message.type) {
    case 'subscribe':
      return `${message.channel_id}:${message.after_seq}`
    case 'unsubscribe':
      return message.channel_id
    default:
      return assertNever(message)
  }
}

export function checkServerEvent(event: ServerEvent): string {
  switch (event.type) {
    case 'message': {
      const message: Message = event.message
      const topic: null = message.topic_id
      return `${message.channel_id}:${message.seq}:${message.client_message_id}:${topic}`
    }
    case 'subscribed':
      return `${event.channel_id}:${event.caught_up_seq}`
    case 'error':
      return `${event.code}:${event.channel_id ?? ''}`
    default:
      return assertNever(event)
  }
}
