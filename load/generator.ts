import { execFileSync } from 'node:child_process';

// GNU make reports any failed recipe as its own exit 2, which hides k6's exit 99 (failed thresholds).
// Expand the Makefile's `load` recipe and run it with the shell make would use: the Makefile stays the
// only definition of the generator command and the caller sees the container's (k6's) exit code.
export function loadRecipe(env: NodeJS.ProcessEnv, cwd = '.'): { file: string; args: string[] } {
  const recipe = execFileSync('make', ['-s', '--no-print-directory', '-n', 'load'], { env, cwd, encoding: 'utf8' }).trim();
  // One shell command (backslash continuations only): a second command would hide the first one's exit code.
  if (!recipe || /(?<!\\)\n/.test(recipe)) throw new Error('make load must expand to exactly one shell command');
  return { file: '/bin/sh', args: ['-c', recipe] };
}

// #469: the first error the generator reported, kept only when it is one of load/scenario.ts's fixed reasons
// (or their fixed shapes): any other text can carry URLs, identifiers or response data and becomes 'unlisted'.
const fixedReasons = new Set(['Subscription refused', 'Unexpected subscription acknowledgement', 'Unexpected Channel', 'Sequence gap',
  'Unexpected event', 'WebSocket error', 'WebSocket closed before delivery completed', 'Received an unknown or excess delivery',
  'Unexpected send response', 'Not all WebSockets subscribed before the deadline', 'Reconnect storm did not recover every subscription',
  'Proxy measurement requires HTTP/1.1, TLS 1.3 and TLS_AES_128_GCM_SHA256 on actual k6 responses']);
export function allowlistedReason(message: string): string {
  const reason = message.replace(/^(?:Error|GoError): /, '').trim();
  if (fixedReasons.has(reason)) return reason;
  if (/^Unexpected event: [a-z_]{1,40}$/.test(reason)) return reason;
  if (/^[a-z_]{1,40} returned \d{1,3}, expected \d{3}$/.test(reason)) return reason;
  return 'unlisted';
}
