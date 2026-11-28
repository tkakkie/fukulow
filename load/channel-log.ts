import { readFileSync } from 'node:fs';

// Legacy fixtures may still target a #515 image. The catalog check avoids
// planning the old INSERT at all once the mutation-only schema is installed.
const body = readFileSync(new URL('./channel-log.sql', import.meta.url), 'utf8').trim();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function createLog(organization: string, channels: string[]): string {
  if (![organization, ...channels].every(id => uuid.test(id))) throw new Error('fixture id is not a UUID');
  const ids = channels.map(id => `'${id}'::uuid`).join(',');
  return `DO $fixture_create_log$
BEGIN
  IF EXISTS (SELECT FROM pg_attribute WHERE attrelid = 'public.channel_log'::regclass
    AND attname = 'client_message_id' AND NOT attisdropped) THEN
    EXECUTE $legacy_create$${body}$legacy_create$ USING '${organization}'::uuid, ARRAY[${ids}]::uuid[];
  END IF;
END $fixture_create_log$;`;
}
