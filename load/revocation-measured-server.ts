import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export const SEND_BUFFER_ENV = 'FUKULOW_MEASUREMENT_SNDBUF';

export function parseSendBuffer(value: string | undefined): number {
  const size = Number(value);
  if (value === undefined || !/^[0-9]+$/.test(value) || !Number.isInteger(size) || size < 1 || size > 2_147_483_647) {
    throw new Error(`${SEND_BUFFER_ENV} must be an integer from 1 to 2147483647`);
  }
  return size;
}

export function spawnMeasuredServer(binary: string, dir: string, port: number, setupToken: string, databaseUrl: string, events = true, prefix: string[] = [], sendBuffer?: number) {
  const tracePath = resolve(dir, `revocation-trace-${randomUUID()}.jsonl`);
  const [file, ...args] = [...prefix, binary];
  const server = spawn(file, args, {
    env: {
      PATH: process.env.PATH,
      FUKULOW_ADDR: `127.0.0.1:${port}`,
      FUKULOW_COOKIE_SECURE: 'false',
      FUKULOW_SETUP_TOKEN: setupToken,
      FUKULOW_REVOCATION_MEASUREMENT: '1',
      FUKULOW_REVOCATION_TRACE_PATH: tracePath,
      FUKULOW_REVOCATION_TRACE_EVENTS: events ? '1' : '0',
      ...(sendBuffer === undefined ? {} : { [SEND_BUFFER_ENV]: String(sendBuffer) }),
      DATABASE_URL: databaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return Object.assign(server, { tracePath });
}

/** Wait through the server's 60 s shutdown deadline, including the dedicated trace drain. */
export async function stopMeasuredServer(server: ChildProcess, timeoutMs = 65_000, killTimeoutMs = 1_000) {
  if (!server.pid || server.exitCode !== null || server.signalCode !== null) return false;
  const signalAndWait = (signal: NodeJS.Signals, timeout: number) => new Promise<boolean | undefined>(resolve => {
    const finish = (clean?: boolean) => {
      clearTimeout(timer);
      server.off('exit', exited);
      resolve(clean);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => finish(code === 0 && signal === null);
    const timer = setTimeout(finish, timeout);
    server.once('exit', exited);
    if (!server.kill(signal)) finish(false);
  });
  const graceful = await signalAndWait('SIGTERM', timeoutMs);
  if (graceful === undefined && server.exitCode === null && server.signalCode === null) await signalAndWait('SIGKILL', killTimeoutMs);
  return graceful === true;
}
