import { readFileSync } from 'node:fs';
// psql statement appending the Create log for directly seeded Messages (#515).
const body = readFileSync(new URL('./channel-log.sql', import.meta.url), 'utf8').trim();
export const createLog = (organization: string, channels: string[]) =>
  `PREPARE fixture_create_log(uuid,uuid[]) AS ${body};\nEXECUTE fixture_create_log('${organization}',ARRAY[${channels.map(id => `'${id}'::uuid`).join(',')}]::uuid[]);\nDEALLOCATE fixture_create_log;`;
