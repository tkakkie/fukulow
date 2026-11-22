// #668 fixture, timeline and run order, as pre-registered (v3 plus the 2026-11-22 approval).
// Change these values only with the maintainer, never after seeing results.
export const SOCKETS_PER_ACCOUNT = 32; // SocketLimits::per_account
export const BYSTANDERS = 1024;
export const GLOBAL_CAP = 4096; // holds GLOBAL_CAP
export const LIVE_QUEUE_CAPACITY = 256; // messages::LIVE_QUEUE_CAPACITY
export const SEND_BURST = 10; // per-Member send limit burst
export const MAX_BODY_CHARS = 4000;
export const REPEATS = 3;

export const CELLS = {
  H512: { accounts: 1, channels: 16 },
  H2048: { accounts: 1, channels: 64 },
  H4096: { accounts: 2, channels: 64 },
  Hcap: { accounts: 3, channels: 64 },
  // Account index 1 (the second Account) is restored to Member during the fault.
  Hfence: { accounts: 2, channels: 64, restoreAccount: 1 },
} as const satisfies Record<string, { accounts: number; channels: number; restoreAccount?: number }>;
export type Cell = keyof typeof CELLS;
export const CELL_NAMES = Object.keys(CELLS) as Cell[];
export const DURATIONS = { short: 3_500, long: 15_000 } as const; // recovery after the pass P, ms
export type Duration = keyof typeof DURATIONS;

/** Offsets from the expected fallback pass P, in ms. */
export const TIMELINE = {
  stall: -4_000, revoke: -3_000, fault: -300, resume: 100, restore: 2_000,
  holdsEndAfterRecovery: 10_000, baselineMs: 10_000,
} as const;

export const baselineWindow = (run: { times: { stall: number } }): [number, number] => [run.times.stall - TIMELINE.baselineMs, run.times.stall];
export const restoreAccount = (cell: Cell): number | undefined => (CELLS[cell] as { restoreAccount?: number }).restoreAccount;
export const targetSockets = (cell: Cell) => CELLS[cell].accounts * SOCKETS_PER_ACCOUNT;
/** T: every target socket loses every revoked Channel. */
export const potentialHolds = (cell: Cell) => targetSockets(cell) * CELLS[cell].channels;
export const socketAccount = (socket: number) => Math.floor(socket / SOCKETS_PER_ACCOUNT);

export type Stall = { senders: number; messages: number; chars: number };
export const STALL_DEFAULT: Stall = { senders: 8, messages: 10, chars: MAX_BODY_CHARS };
export function checkStall(stall: Stall) {
  if (![stall.senders, stall.messages, stall.chars].every(n => Number.isInteger(n) && n > 0)) throw new Error('stall options must be positive integers');
  if (stall.messages > SEND_BURST) throw new Error(`at most ${SEND_BURST} stall Messages per sender (send limit burst)`);
  if (stall.chars > MAX_BODY_CHARS) throw new Error(`at most ${MAX_BODY_CHARS} characters per stall Message`);
  // Half the live queue keeps well clear of the 256-entry overflow close.
  if (stall.senders * stall.messages > LIVE_QUEUE_CAPACITY / 2) throw new Error(`at most ${LIVE_QUEUE_CAPACITY / 2} stall Messages in total`);
  return stall;
}
// Four UTF-8 bytes per scalar maximise the bytes per Message.
export const stallBody = (chars: number) => '\u{1F989}'.repeat(chars);

export type PlannedRun = { kind: 'fault'; cell: Cell; duration: Duration; repeat: number } | { kind: 'control'; cell: Cell; repeat: number };
export const runId = (run: PlannedRun) => run.kind === 'fault' ? `${run.cell}-${run.duration}-r${run.repeat}` : `${run.cell}-control-r${run.repeat}`;

/** Interleaved order: each repeat visits every cell, alternating direction so host drift affects all alike. */
export function planRuns(cells: readonly Cell[], durations: readonly Duration[], repeats: number, controls: boolean): PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const cell of repeat % 2 ? cells : [...cells].reverse()) {
      const order = repeat % 2 ? durations : [...durations].reverse();
      const faults = order.map(duration => ({ kind: 'fault', cell, duration, repeat }) as const);
      const control = controls ? [{ kind: 'control', cell, repeat } as const] : [];
      runs.push(...(repeat % 2 ? [...faults, ...control] : [...control, ...faults]));
    }
  }
  return runs;
}

export type Options = { out: string; cells: Cell[]; durations: Duration[]; repeats: number; controls: boolean; stall: Stall };
export function parseOptions(args: readonly string[]): Options {
  const option = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const out = option('--out');
  if (!out) throw new Error('Use --out /absolute/new/external/directory');
  const list = <T extends string>(name: string, allowed: readonly T[]) => {
    const values = option(name)?.split(',') ?? [...allowed];
    if (!values.length || values.some(v => !allowed.includes(v as T))) throw new Error(`${name} accepts ${allowed.join(',')}`);
    return values as T[];
  };
  const repeats = Number(option('--repeats') ?? REPEATS);
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a positive integer');
  const controls = option('--controls') ?? 'on';
  if (controls !== 'on' && controls !== 'off') throw new Error('--controls accepts on,off');
  const number = (name: string, fallback: number) => Number(option(name) ?? fallback);
  const stall = checkStall({
    senders: number('--stall-senders', STALL_DEFAULT.senders),
    messages: number('--stall-messages', STALL_DEFAULT.messages),
    chars: number('--stall-chars', STALL_DEFAULT.chars),
  });
  return { out, cells: list('--cells', CELL_NAMES), durations: list('--durations', ['short', 'long'] as const), repeats, controls: controls === 'on', stall };
}
