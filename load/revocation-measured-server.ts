import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export function spawnMeasuredServer(binary: string, dir: string, port: number, setupToken: string, databaseUrl: string) {
  return spawn(binary, [], {
    env: {
      PATH: process.env.PATH,
      FUKULOW_ADDR: `127.0.0.1:${port}`,
      FUKULOW_COOKIE_SECURE: 'false',
      FUKULOW_SETUP_TOKEN: setupToken,
      FUKULOW_REVOCATION_MEASUREMENT: '1',
      FUKULOW_REVOCATION_TRACE_PATH: resolve(dir, `revocation-trace-${randomUUID()}.jsonl`),
      DATABASE_URL: databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
