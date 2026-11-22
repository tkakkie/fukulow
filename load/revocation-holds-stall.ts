// #668 stall proxy: one TCP relay per target WebSocket. Pausing stops reading from the
// server side, so the kernel buffers fill and the server's WebSocket send blocks.
// Client-to-server bytes always flow, so pongs and control frames still reach the server.
import { connect, createServer, type Server, type Socket } from 'node:net';

export type StallRecord = {
  reads: { at: number; bytes: number }[]; // bytes read from the server side
  pausedAt: number[]; resumedAt: number[];
  closes: { at: number; side: 'client' | 'upstream' }[];
};

export class StallProxy {
  readonly record: StallRecord = { reads: [], pausedAt: [], resumedAt: [], closes: [] };
  private server: Server | undefined;
  private client: Socket | undefined;
  private upstream: Socket | undefined;
  private paused = false;
  private target: { host: string; port: number };
  private clock: () => number;
  constructor(target: { host: string; port: number }, clock: () => number = () => performance.now()) { this.target = target; this.clock = clock; }

  listen(): Promise<number> {
    this.server = createServer(client => this.accept(client));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (!address || typeof address === 'string') return reject(new Error('Stall proxy has no port'));
        resolve(address.port);
      });
    });
  }

  pause() {
    this.paused = true;
    this.upstream?.pause();
    this.record.pausedAt.push(this.clock());
  }

  resume() {
    this.paused = false;
    this.upstream?.resume();
    this.record.resumedAt.push(this.clock());
  }

  close(): Promise<void> {
    this.client?.destroy(); this.upstream?.destroy();
    return new Promise(resolve => this.server ? this.server.close(() => resolve()) : resolve());
  }

  private accept(client: Socket) {
    // One WebSocket per proxy keeps the socket identity unambiguous.
    if (this.client) { client.destroy(); return; }
    const upstream = connect(this.target.port, this.target.host);
    this.client = client; this.upstream = upstream;
    client.setNoDelay(true); upstream.setNoDelay(true);
    let ended = false;
    const end = (side: 'client' | 'upstream') => () => {
      if (ended) return;
      ended = true;
      this.record.closes.push({ at: this.clock(), side });
      client.destroy(); upstream.destroy();
    };
    client.on('error', end('client')); client.on('close', end('client'));
    upstream.on('error', end('upstream')); upstream.on('close', end('upstream'));
    client.on('data', (chunk: Buffer) => { upstream.write(chunk); });
    upstream.on('data', (chunk: Buffer) => {
      this.record.reads.push({ at: this.clock(), bytes: chunk.length });
      client.write(chunk);
    });
    if (this.paused) upstream.pause();
  }
}

/** Bytes read from the server side in [from, to). */
export const bytesBetween = (record: StallRecord, from: number, to: number) =>
  record.reads.filter(read => read.at >= from && read.at < to).reduce((sum, read) => sum + read.bytes, 0);
