// Client for the native TCP proxy process. The WebSocket clients still own protocol parsing.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { encloseClockBrackets, intersectClockBrackets, type ClockSample } from './revocation-burst-judgment.ts';
import type { StallRecord } from './revocation-holds-stall.ts';

type Command = 'ping' | 'pause' | 'resume';
type ProxyEvent =
  | { event: 'listening'; socket: number; port: number }
  | { event: 'connected'; socket: number; before: number; after: number; upstream_port: number }
  | { event: 'read'; socket: number; at: number; bytes: number }
  | { event: 'close'; socket: number; at: number; side: 'client' | 'upstream' }
  | { event: 'socket_error'; socket: number }
  | { event: 'ack'; command: Command; at: number };

export type Readback = { before: number; after: number };
export type TargetReadback = Readback & { upstreamPort: number };
export type ClockBounds = [number, number];

function commandBounds(sample: ClockSample, [low, high]: ClockBounds): ClockBounds {
  const bounds: ClockBounds = [Math.max(sample.beforeMs, sample.serverMs + low), Math.min(sample.afterMs, sample.serverMs + high)];
  return bounds[0] <= bounds[1] ? bounds : [sample.beforeMs, sample.afterMs];
}

export class NativeStall {
  private child: ChildProcessWithoutNullStreams;
  private closed: Promise<void>;
  private events = new EventEmitter();
  private failure?: Error;
  private ports = new Map<number, number>();
  private connected = new Map<number, TargetReadback>();
  private acks = new Map<Command, number>();
  private failedSockets = new Set<number>();
  private records: StallRecord[];
  private closing = false;

  constructor(binary: string, port: number, count: number) {
    this.records = Array.from({ length: count }, () => ({ reads: [], closes: [], pausedAt: [], resumedAt: [] }));
    this.child = spawn(binary, [String(port), String(count)], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume();
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      if (!this.closing) this.fail(new Error(`stall helper exited (${signal ?? code})`));
      resolve();
    }));
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line) as ProxyEvent); }
      catch { this.fail(new Error('invalid stall helper record')); }
    });
  }

  get pid() { return this.child.pid; }

  upstreamPort(socket: number) { return this.connected.get(socket)?.upstreamPort; }

  private fail(error: Error) {
    this.failure ??= error;
    this.events.emit('update');
  }

  private receive(event: ProxyEvent) {
    if (event.event === 'ack') {
      if (!Number.isFinite(event.at)) throw new Error('invalid timestamp');
      this.acks.set(event.command, event.at);
    } else {
      const record = this.records[event.socket];
      if (!record) throw new Error('invalid socket index');
      switch (event.event) {
        case 'listening': this.ports.set(event.socket, event.port); break;
        case 'connected': {
          if (this.connected.has(event.socket) || !Number.isInteger(event.upstream_port) || event.upstream_port < 1 || event.upstream_port > 65_535) {
            throw new Error('invalid upstream port or duplicate target connection');
          }
          this.connected.set(event.socket, { before: event.before, after: event.after, upstreamPort: event.upstream_port });
          break;
        }
        case 'read': record.reads.push({ at: event.at, bytes: event.bytes }); break;
        case 'close': record.closes.push({ at: event.at, side: event.side }); break;
        case 'socket_error': this.failedSockets.add(event.socket); break;
      }
    }
    this.events.emit('update');
  }

  private wait<T>(value: () => T | undefined, description: string, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); this.events.off('update', check); };
      const check = () => {
        try {
          if (this.failure) throw this.failure;
          const result = value();
          if (result !== undefined) { stop(); resolve(result); }
        } catch (error) { stop(); reject(error); }
      };
      const timer = setTimeout(() => { stop(); reject(new Error(`stall helper did not report ${description}`)); }, timeoutMs);
      this.events.on('update', check);
      check();
    });
  }

  listening() {
    return this.wait(() => this.ports.size === this.records.length
      ? this.records.map((_, i) => this.ports.get(i)!) : undefined, 'all listener ports', 10_000);
  }

  readbacks() {
    return this.wait(() => {
      if (this.failedSockets.size > 0) throw new Error(`stall helper target connection failed (socket ${[...this.failedSockets].join(', ')})`);
      if (this.connected.size === this.records.length) return this.records.map((_, i) => this.connected.get(i)!);
    }, 'all target SO_RCVBUF readbacks', 10_000);
  }

  async command(command: Command): Promise<ClockSample> {
    this.acks.delete(command);
    const beforeMs = performance.now();
    this.child.stdin.write(`${command}\n`);
    const serverMs = await this.wait(() => this.acks.get(command), `${command} acknowledgement`, 2_000);
    return { beforeMs, afterMs: performance.now(), serverMs };
  }

  async calibrate(): Promise<ClockBounds> {
    const samples: ClockSample[] = [];
    for (let i = 0; i < 8; i++) samples.push(await this.command('ping'));
    return intersectClockBrackets(samples);
  }

  async close() {
    this.closing = true;
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1_000);
    this.child.stdin.end('quit\n');
    try { await this.closed; }
    finally { clearTimeout(timer); }
  }

  evidence(pause: ClockSample | undefined, resume: ClockSample | undefined, start: ClockBounds, end: ClockBounds | undefined) {
    const offsets = end ? encloseClockBrackets(start, end) : undefined;
    const bounds = (sample: ClockSample): ClockBounds => offsets ? commandBounds(sample, offsets) : [sample.beforeMs, sample.afterMs];
    const pauseBounds = pause && bounds(pause);
    const resumeBounds = resume && bounds(resume);
    const origin = resume ?? pause;
    const atOrigin = resumeBounds?.[0] ?? pauseBounds?.[0] ?? 0;
    // Map relative to resume so the order of reads and release on the helper clock is preserved.
    const map = (at: number) => origin ? atOrigin + (at - origin.serverMs) : at + start[0];
    const records = this.records.map(record => ({
      reads: record.reads.map(read => ({ ...read, at: map(read.at) })),
      closes: record.closes.map(close => ({ ...close, at: map(close.at) })),
      pausedAt: pauseBounds ? [pauseBounds[1]] : [], resumedAt: resumeBounds ? [resumeBounds[0]] : [],
    }));
    return { records, pauseBounds, resumeBounds, helperClock: { offsets, pause, resume } };
  }
}
