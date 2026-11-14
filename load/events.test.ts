import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerEvent } from '../web/src/api-schema.d.ts';
import { isActivityNotice } from './events.ts';

test('Message load accepts the automatic ready frame and notices without counting subscriptions or deliveries', () => {
  const notices: ServerEvent[] = [
    { type: 'activity_ready' }, { type: 'activity_reset' },
    { type: 'channel_activity', channel_id: 'c', seq: 1 },
    { type: 'read_position_changed', channel_id: 'c', topic_id: null, read_seq: 1 },
    { type: 'channel_access_gained', channel_id: 'c' },
    { type: 'channel_access_revoked', channel_id: 'c' },
    { type: 'channel_list_changed' }, { type: 'channel_members_changed', channel_id: 'c' },
    { type: 'members_changed' },
  ];
  for (const notice of notices) assert.equal(isActivityNotice(notice), true, notice.type);
  for (const event of [
    { type: 'message', message: { id: 'm', channel_id: 'c', client_message_id: 'key', sender: 'member',
      body: 'Load test message', seq: 1, created_at: '2026-11-14T00:00:00Z',
      topic_id: null, reply_to: null, reply_root_id: null, mentions: [] } },
    { type: 'subscribed', channel_id: 'c', caught_up_seq: 0 },
    { type: 'channel_access_lost', channel_id: 'c' },
    { type: 'error', channel_id: 'c', code: 'channel_not_found' },
  ] satisfies ServerEvent[]) assert.equal(isActivityNotice(event), false, event.type);
});
