import type { ServerEvent } from '../web/src/api-schema.d.ts';

// Organization invalidations are independent of this Message-delivery workload.
// Keep subscription acknowledgements, denials and sequence checks in the scenario.
export function isActivityNotice(event: ServerEvent): boolean {
  switch (event.type) {
    case 'activity_ready':
    case 'activity_reset':
    case 'channel_activity':
    case 'read_position_changed':
    case 'channel_access_gained':
    case 'channel_access_revoked':
    case 'channel_list_changed':
    case 'channel_members_changed':
    case 'members_changed':
      return true;
    default:
      return false;
  }
}
