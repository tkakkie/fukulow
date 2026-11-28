import { modelLabel } from './design.ts';
import { heap, lookup } from './sampler.ts';

export const snapshots = ['W0', 'W1', modelLabel, 'W3 IDLE', 'W3 VACUUM', 'W3 REINDEX'] as const;
export type SnapshotId = typeof snapshots[number];

export async function sequence(actions: {
  sql: (text: string, maintenance?: 'W3 VACUUM' | 'W3 REINDEX') => Promise<unknown>;
  snapshot: (name: SnapshotId) => Promise<void>;
  sends: () => Promise<void>;
  model: () => Promise<void>;
  idle: () => Promise<void>;
}) {
  await actions.sql('VACUUM ANALYZE;');
  await actions.snapshot('W0');
  await actions.sends();
  await actions.snapshot('W1');
  await actions.model();
  await actions.snapshot(modelLabel);
  await actions.idle();
  await actions.snapshot('W3 IDLE');
  await actions.sql(`VACUUM ${heap};`, 'W3 VACUUM');
  await actions.snapshot('W3 VACUUM');
  await actions.sql(`REINDEX INDEX CONCURRENTLY ${lookup};`, 'W3 REINDEX');
  await actions.snapshot('W3 REINDEX');
}
