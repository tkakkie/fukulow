// Read the final Create positions for the disposable run's stall Channel.
import { sql, type Database } from './revocation-burst-db.ts';
import type { StallRow, StallSnapshot } from './revocation-holds-e6.ts';

export function snapshotStallRows(db: Database, organization: string, channel: string): StallSnapshot {
  try {
    const rows = sql(db, `
      SELECT COALESCE(json_agg(stall ORDER BY seq), '[]')
      FROM (
        SELECT id, client_message_id, sender, seq, created_at
        FROM messages
        WHERE organization_id = '${organization}'::uuid AND channel_id = '${channel}'::uuid
      ) AS stall;
    `);
    return { rows: JSON.parse(rows) as StallRow[] };
  } catch (error) {
    return { error: (error as Error).message };
  }
}
