// The postgres image's init step runs a temporary socket-only server. A socket check (the Compose
// healthcheck) can pass against it just before it shuts down, so readiness always goes over TCP.
export const tcpReadinessArgs = (service: string[]) =>
  [...service, 'pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres'];

export async function waitReady(check: () => boolean, o: { tries?: number; delayMs?: number; stable?: number } = {}) {
  const { tries = 120, delayMs = 500, stable = 2 } = o;
  let streak = 0;
  for (let i = 0; i < tries; i++) {
    streak = check() ? streak + 1 : 0;
    if (streak >= stable) return;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('PostgreSQL was not ready over TCP');
}

// Measurement sessions keep the pinned settings. Setup (seed, settle, VACUUM) at full fixture size can
// legitimately exceed a measurement statement_timeout, so setup sessions turn it off.
export const setupOptions = (measured: string) => `${measured} -c statement_timeout=0`;

// Child diagnostics can embed connection strings or SQL. Keep only SQLSTATE.
export const sqlState = (stderr: string) =>
  /^(?:psql:.*?:\s*)?(?:FATAL|ERROR):\s+([A-Z0-9]{5})(?=[:\s]|$)/m.exec(stderr)?.[1];

export const sqlStateMeaning: Record<string, string> = {
  '57014': 'statement canceled (statement_timeout or cancel request)',
  '57P01': 'server shutting down',
  '53100': 'disk full',
  '08006': 'connection failure',
};
