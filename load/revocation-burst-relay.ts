// Test relay for #592: forwards the server's PostgreSQL connections to a disposable
// local container, counts and times statements, and simulates the two failure types.
// It never logs SQL text, parameters or credentials.
import { createServer, connect, type Server, type Socket } from 'node:net';

// Only the revocation recheck (`authorize_batch`) uses this unnest alias.
export const RECHECK_MARKER = 'WITH ORDINALITY r(member_id,revision,hash,channel,n)';
// The gate function raises while the harness's control row is set; see revocation-burst-db.ts.
// The fallback worker's session pass (server/src/auth/session/recheck.rs) starts every pass.
export const FALLBACK_MARKER = 'AS registered(organization_id, token_hash, revision)';
export const gateQuery = (query: string) => `SELECT * FROM (${query}) fk592_scoped WHERE public.fk592_gate()`;

export type Statement = { at: number; ms: number; recheck: boolean; fallback: boolean; error: boolean };
type Pending = { at: number; recheck: boolean; fallback: boolean; error: boolean };

const cstring = (buffer: Buffer, offset: number): [string, number] => {
  const end = buffer.indexOf(0, offset);
  if (end < 0) throw new Error('Unterminated protocol string');
  return [buffer.toString('utf8', offset, end), end + 1];
};

/** Rewrites a Parse body when it carries the recheck statement. Returns the new body and the statement name. */
export function rewriteParse(body: Buffer): { body: Buffer; name: string; recheck: boolean; fallback: boolean } {
  const [name, afterName] = cstring(body, 0);
  const [query, afterQuery] = cstring(body, afterName);
  if (!query.includes(RECHECK_MARKER)) return { body, name, recheck: false, fallback: query.includes(FALLBACK_MARKER) };
  const rewritten = Buffer.from(gateQuery(query), 'utf8');
  return { body: Buffer.concat([body.subarray(0, afterName), rewritten, Buffer.from([0]), body.subarray(afterQuery)]), name, recheck: true, fallback: false };
}

export function bindStatement(body: Buffer): string {
  const [, afterPortal] = cstring(body, 0);
  return cstring(body, afterPortal)[0];
}

export const frame = (type: number, body: Buffer) => {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};

/** Splits typed messages; `startup` handles the untyped first client message. */
export class Framer {
  private buffer = Buffer.alloc(0);
  private startup: boolean;
  constructor(startup: boolean) { this.startup = startup; }
  push(chunk: Buffer, emit: (type: number | null, body: Buffer, raw: Buffer) => void) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.startup) {
        if (this.buffer.length < 8) return;
        const length = this.buffer.readInt32BE(0);
        if (this.buffer.length < length) return;
        const raw = this.buffer.subarray(0, length);
        this.buffer = this.buffer.subarray(length);
        const code = raw.readInt32BE(4);
        // SSL and GSS requests keep the stream untyped; the harness uses sslmode=disable.
        if (code !== 80877103 && code !== 80877104) this.startup = false;
        emit(null, raw.subarray(4), raw);
        continue;
      }
      if (this.buffer.length < 5) return;
      const length = this.buffer.readInt32BE(1);
      if (this.buffer.length < length + 1) return;
      const raw = this.buffer.subarray(0, length + 1);
      this.buffer = this.buffer.subarray(length + 1);
      emit(raw[0], raw.subarray(5), raw);
    }
  }
}

export class Relay {
  readonly statements: Statement[] = [];
  readonly connections: number[] = [];
  readonly refused: number[] = [];
  private server: Server | undefined;
  private live = new Set<Socket>();
  private outage = false;
  private target: { host: string; port: number };
  private clock: () => number;
  constructor(target: { host: string; port: number }, clock: () => number = () => performance.now()) { this.target = target; this.clock = clock; }

  listen(): Promise<number> {
    this.server = createServer(client => this.accept(client));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (!address || typeof address === 'string') return reject(new Error('Relay has no port'));
        resolve(address.port);
      });
    });
  }

  /** Whole-database outage: drop every relayed connection and refuse new ones until cleared. */
  setOutage(on: boolean) {
    this.outage = on;
    if (on) for (const socket of this.live) socket.destroy();
  }

  close(): Promise<void> {
    for (const socket of this.live) socket.destroy();
    return new Promise(resolve => this.server ? this.server.close(() => resolve()) : resolve());
  }

  private accept(client: Socket) {
    const at = this.clock();
    if (this.outage) {
      this.refused.push(at);
      client.destroy();
      return;
    }
    this.connections.push(at);
    const upstream = connect(this.target.port, this.target.host);
    this.live.add(client); this.live.add(upstream);
    const end = () => { client.destroy(); upstream.destroy(); this.live.delete(client); this.live.delete(upstream); };
    client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end);
    client.setNoDelay(true); upstream.setNoDelay(true);
    const recheckNames = new Set<string>(), fallbackNames = new Set<string>();
    const pending: Pending[] = [];
    let batchRecheck = false, batchFallback = false;
    const fromClient = new Framer(true);
    const fromServer = new Framer(false);
    client.on('data', (chunk: Buffer) => fromClient.push(chunk, (type, body, raw) => {
      if (type === 0x50) { // Parse
        const parsed = rewriteParse(body);
        if (parsed.recheck) recheckNames.add(parsed.name);
        else recheckNames.delete(parsed.name);
        if (parsed.fallback) fallbackNames.add(parsed.name);
        else fallbackNames.delete(parsed.name);
        upstream.write(parsed.recheck ? frame(type, parsed.body) : raw);
        return;
      }
      if (type === 0x42) { // Bind
        const statement = bindStatement(body);
        if (recheckNames.has(statement)) batchRecheck = true;
        if (fallbackNames.has(statement)) batchFallback = true;
      }
      if (type === 0x53 || type === 0x51) { // Sync or simple Query
        pending.push({ at: this.clock(), recheck: batchRecheck, fallback: batchFallback, error: false });
        batchRecheck = false; batchFallback = false;
      }
      upstream.write(raw);
    }));
    upstream.on('data', (chunk: Buffer) => fromServer.push(chunk, (type, _body, raw) => {
      if (type === 0x45 && pending[0]) pending[0].error = true; // ErrorResponse
      if (type === 0x5a) { // ReadyForQuery
        const done = pending.shift();
        if (done) this.statements.push({ at: done.at, ms: this.clock() - done.at, recheck: done.recheck, fallback: done.fallback, error: done.error });
      }
      client.write(raw);
    }));
  }
}
