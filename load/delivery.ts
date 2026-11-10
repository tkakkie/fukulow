// A send can arrive on WebSockets before its HTTP response completes.
export class Deliveries {
  private pending = new Map<string, { started: number; remaining: number }>();

  start(id: string, started: number, subscribers: number): void {
    this.pending.set(id, { started, remaining: subscribers });
  }

  receive(id: string, now: number): number {
    const send = this.pending.get(id);
    if (!send) throw new Error('Received an unknown or excess delivery');
    const latency = now - send.started;
    if (--send.remaining === 0) this.pending.delete(id);
    return latency;
  }

  cancel(id: string): void {
    this.pending.delete(id);
  }

  get missing(): number {
    let missing = 0;
    for (const send of this.pending.values()) missing += send.remaining;
    return missing;
  }
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('Load settings must be positive safe integers');
  }
  return Number(value);
}
