// #756 burst mode of the #359 owner harness: options, the pre-registered schedule and the disposable
// stack override. Everything here is fixed by the pre-registration (issue #756, comment 7075307714,
// approved 2026-11-22); results never change it. Only --recorded is evidence.
import { parseArgs } from 'node:util';
import { modeOf, type Mode } from './harness-core/stages.ts';

export const ATTACKER_IP = '10.0.0.1', OWNER_IP = '10.0.0.2', READER_IP = '10.0.0.3';
export const POOL_MAX = 20, TIMEOUT_MS = 45_000;
export const OWNER_EMAIL = 'owner@example.invalid';
// Pre-registered load: 16 wrong passwords per burst; the email budget admits 5. A burst with no
// admitted attempt is re-sent after 250 ms, at most 4 times. The next burst goes 60.2 s after the
// previous burst's admitted send. The burst-time owner operation goes 10 ms after the admitted send.
export const BURST = { size: 16, resendMs: 250, maxResends: 4, gapMs: 60_200, ownerOffsetMs: 10 } as const;
// Owner sign-ins at odd whole seconds (web/native alternating), authenticated operations every 5 s from
// 2.5 s (password change/revoke-others alternating), Organization B reads every 500 ms.
export const SCHEDULE = { signinFirstMs: 1_000, signinEveryMs: 2_000, authFirstMs: 2_500, authEveryMs: 5_000,
  readEveryMs: 500, readInFlight: 4 } as const;
export const SAMPLER = { watchSeconds: 0.02, medianMaxMs: 25 } as const;

export type Plan = { b0Ms: number; bursts: number; b1TailMs: number; b2Ms: number; headroom: boolean; failFast: boolean };
// recorded: B0 60 s, 3 bursts, B1 until 61 s after the last counted failure, B2 70 s.
// rehearsal: the same setup end to end, then one short cell (one burst); never evidence. B0 stays long
// enough (8 authenticated operations) to exercise the post-B0 fail-fast checks.
// smoke: a plumbing check without the Docker headroom probe or the post-B0 checks; never evidence.
export const PLANS: Record<Mode, Plan> = {
  recorded: { b0Ms: 60_000, bursts: 3, b1TailMs: 61_000, b2Ms: 70_000, headroom: true, failFast: true },
  rehearsal: { b0Ms: 40_000, bursts: 1, b1TailMs: 5_000, b2Ms: 5_000, headroom: true, failFast: true },
  smoke: { b0Ms: 10_000, bursts: 1, b1TailMs: 3_000, b2Ms: 3_000, headroom: false, failFast: false },
};
export const RECORDED_BURSTS = PLANS.recorded.bursts;

export const usage = 'node load/signin-owner-burst.ts (--smoke | --rehearsal | --recorded --harness-commit SHA) --out NEW_ABSOLUTE_DIR_OUTSIDE_CHECKOUT';

export function parseBurstArgs(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    smoke: { type: 'boolean' }, rehearsal: { type: 'boolean' }, recorded: { type: 'boolean' },
    out: { type: 'string' }, 'harness-commit': { type: 'string' } } });
  if (positionals.length) throw new Error(usage);
  const mode = modeOf(values);
  const out = values.out;
  if (!out || !out.startsWith('/')) throw new Error(usage);
  const commit = values['harness-commit'];
  if (mode === 'recorded' && !/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('--recorded needs --harness-commit <40-hex SHA>');
  if (mode !== 'recorded' && commit !== undefined) throw new Error('--harness-commit is only for --recorded');
  return { mode, out, harnessCommit: commit ?? null, plan: PLANS[mode] };
}

export function parseBurstEnv(env: Record<string, string | undefined>) {
  const port = env.LOAD_PORT ?? '18098';
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || [8080, 55432].includes(Number(port)))
    throw new Error('Use a non-default unprivileged LOAD_PORT');
  if (env.SERVER_REF && env.LOAD_APP_IMAGE) throw new Error('Choose SERVER_REF or LOAD_APP_IMAGE');
  return { port: Number(port), serverRef: env.SERVER_REF || null, appImage: env.LOAD_APP_IMAGE || null };
}

// The approved lock-wait logging (maintainer, 2026-11-22) exists ONLY in this disposable stack's
// Compose override, never in load/compose.yml, deploy/ or server defaults. It keeps load/compose.yml's
// pg_stat_statements flags, because a `command` in an override replaces the base one.
export const LOCK_LOG_SETTINGS = ['log_lock_waits=on', 'deadlock_timeout=10ms', 'log_line_prefix=%m [%p] ', 'log_timezone=UTC'] as const;
export const BASE_DB_FLAGS = ['shared_preload_libraries=pg_stat_statements', 'pg_stat_statements.track=all'] as const;

export function disposableOverride() {
  return { services: {
    app: { environment: { FUKULOW_CLIENT_IP_HEADER: 'x-load-client-ip', FUKULOW_TRUSTED_PROXIES: '0.0.0.0/0,::/0' } },
    db: { command: ['postgres', ...[...BASE_DB_FLAGS, ...LOCK_LOG_SETTINGS].flatMap(flag => ['-c', flag])] },
  } };
}

export const LOGGING_NOTE = 'deadlock_timeout=10ms with log_lock_waits=on (disposable stack only): each lock wait '
  + 'longer than 10 ms runs a deadlock check and writes one log message, and its acquisition writes another. '
  + 'This adds work only to waits already over 10 ms, i.e. the waits being measured, and makes lock waits on X\'s '
  + 'row slightly longer than without the logging. No run without the logging is made (that would change the '
  + 'load condition); the effect is bounded by the counts in results.json logging (deadlock checks, log messages, '
  + 'log bytes) and can be compared against the #359 B0 owner latencies, which had default settings.';
