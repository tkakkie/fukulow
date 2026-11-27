import assert from 'node:assert/strict';
import { hash } from '../manifest.ts';
import { owner, verifyImage, type Images, type Names } from './cluster.ts';
import { full, sourceCommit } from './design.ts';
import { git, loadManifest } from './manifest.ts';

const settingsSql = `SELECT jsonb_object_agg(name, jsonb_build_object('value', setting, 'source', source, 'unit', unit))
  FROM pg_settings;`;
const relOptions = `SELECT jsonb_object_agg(relname, reloptions) FROM pg_class WHERE oid IN (
  'public.messages'::regclass, 'public.message_search_terms'::regclass,
  'public.message_search_terms_lookup'::regclass, 'public.message_search_terms_maintenance'::regclass);`;

export function identity(resources: Names, images: Images) {
  const manifest = loadManifest();
  verifyImage(resources.server, images.pg);
  verifyImage(resources.client, images.pg);
  const settings = JSON.parse(owner(resources, settingsSql)) as Record<string, {value: string; source: string; unit: string | null}>;
  for (const [name, value] of Object.entries(manifest.frozen.postgres.required)) {
    assert.equal(settings[name]?.value, value, `Effective PostgreSQL setting mismatch: ${name}`);
  }
  assert.equal(settings.server_version_num?.value, manifest.frozen.postgres.serverVersion);
  assert.ok(Object.values(settings).every(setting => setting.source !== 'command line'), 'Unexpected PostgreSQL command-line override');
  const tables = JSON.parse(owner(resources, relOptions));
  assert.ok(Object.values(tables).length === 4 && Object.values(tables).every(value => value === null),
    'Unexpected relation storage override');
  return {commit: git('rev-parse', 'HEAD'), productCommit: sourceCommit, manifest: manifest.fileHash,
    images, settingsHash: hash(JSON.stringify({settings, tables})), settings, tables, seed: full.seed};
}
export type Identity = ReturnType<typeof identity>;
