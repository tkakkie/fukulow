// Disposable PostgreSQL for #592. Every container is named fk592-* and removed by the runner.
// Passwords and tokens stay in memory or a 0600 file outside the checkout; nothing prints them.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const checkout = resolve(import.meta.dirname, '..');
// Same pinned image as load/compose.yml.
export const POSTGRES_IMAGE = 'postgres:18.6@sha256:e3d24f6906d0760bf4da0dae872415391ededefad23fd471c47dc53b0ddf3c42';
const quiet = (file: string, args: string[], input?: string) =>
  execFileSync(file, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

export type Database = { name: string; port: number; ownerPassword: string; appPassword: string };

export function startDatabase(name: string, launch = { options: [] as string[], command: ['postgres'] }): Database {
  if (!name.startsWith('fk592-')) throw new Error('fk592 containers only');
  const ownerPassword = randomBytes(18).toString('hex'), appPassword = randomBytes(18).toString('hex');
  const mount = (file: string, target: string) => ['-v', `${checkout}/deploy/${file}:${target}:ro`];
  quiet('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql',
    '-e', 'POSTGRES_USER=fukulow', '-e', 'POSTGRES_DB=fukulow', '-e', `POSTGRES_PASSWORD=${ownerPassword}`, '-e', `POSTGRES_APP_PASSWORD=${appPassword}`,
    ...mount('init-db-roles.sh', '/docker-entrypoint-initdb.d/10-db-roles.sh'), ...mount('db-roles.sql', '/opt/fukulow/db-roles.sql'),
    ...mount('db-role-settings.sql', '/opt/fukulow/db-role-settings.sql'), ...mount('db-grants.sql', '/opt/fukulow/db-grants.sql'),
    ...launch.options, POSTGRES_IMAGE, ...launch.command, '-c', 'max_connections=300']);
  try {
    const port = Number(quiet('docker', ['port', name, '5432/tcp']).split('\n')[0].split(':').pop());
    return { name, port, ownerPassword, appPassword };
  } catch (error) {
    removeDatabase(name);
    throw error;
  }
}

export async function waitReady(db: Database) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      // The entrypoint restarts PostgreSQL after init scripts; require TCP readiness twice.
      quiet('docker', ['exec', db.name, 'pg_isready', '-h', '127.0.0.1', '-U', 'fukulow', '-d', 'fukulow']);
      quiet('docker', ['exec', db.name, 'psql', '-h', '127.0.0.1', '-U', 'fukulow', '-d', 'fukulow', '-Atc', 'SELECT 1'], undefined);
      return;
    } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('Database did not become ready');
}

export const removeDatabase = (name: string) => { if (name.startsWith('fk592-')) try { quiet('docker', ['rm', '-f', '-v', name]); } catch { /* already gone */ } };

export function sql(db: Database, text: string) {
  try { return quiet('docker', ['exec', '-i', db.name, 'psql', '-X', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-At'], text); }
  catch { throw new Error('Disposable database command failed (diagnostics suppressed)'); }
}

/** Test-only objects outside the application schema contract; the app role may only execute the gate. */
export function installGate(db: Database) {
  sql(db, `CREATE TABLE public.fk592_control (id int PRIMARY KEY, failing boolean NOT NULL);
INSERT INTO public.fk592_control VALUES (1, false);
CREATE FUNCTION public.fk592_gate() RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (SELECT failing FROM public.fk592_control WHERE id = 1) THEN RAISE EXCEPTION 'fk592 simulated recheck failure'; END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.fk592_gate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fk592_gate() TO fukulow_app;`);
}

export type Seeded = { members: { id: string; token: string }[] };
/** Members with Account Sessions inserted directly; Channels and grants go through the API. */
export function seedMembers(db: Database, organization: string, count: number): Seeded {
  const members: Seeded['members'] = [];
  const lines = ['BEGIN;'];
  for (let index = 0; index < count; index++) {
    const account = randomUUID(), id = randomUUID(), token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    members.push({ id, token });
    lines.push(`INSERT INTO accounts (id,email,password_hash) VALUES ('${account}','fk592-${account}@example.invalid','unused');`,
      `INSERT INTO users (organization_id,id,account_id,name,role) VALUES ('${organization}','${id}','${account}','Load ${index}','member');`,
      `INSERT INTO account_sessions (account_id,token_hash) VALUES ('${account}',decode('${hash}','hex'));`);
  }
  lines.push('COMMIT;');
  sql(db, lines.join('\n'));
  return { members };
}

/** One persistent psql session over the container's Unix socket. */
export class Session {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private waiters = new Map<string, (ok: boolean) => void>();
  constructor(db: Database, spawnSession: (file: string, args: string[], options: { stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcessWithoutNullStreams = spawn) {
    this.child = spawnSession('docker', ['exec', '-i', db.name, 'psql', '-X', '-q', '-U', 'fukulow', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1', '-At', '-f', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
        const waiter = this.waiters.get(line);
        if (waiter) { this.waiters.delete(line); waiter(true); }
      }
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.markClosed());
    this.child.on('error', () => this.markClosed());
    this.child.on('close', () => this.markClosed());
  }
  private closed = false;
  private markClosed() {
    this.closed = true;
    for (const waiter of this.waiters.values()) waiter(false);
    this.waiters.clear();
  }
  /** Runs `statement` (no output), then echoes a unique tag; resolves when the tag returns. */
  run(statement: string, timeoutMs = 10_000): Promise<boolean> {
    const tag = `fk592-${randomUUID()}`;
    if (this.closed) return Promise.resolve(false);
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waiters.delete(tag); resolve(false); }, timeoutMs);
      this.waiters.set(tag, ok => { clearTimeout(timer); resolve(ok); });
      this.child.stdin.write(`${statement}\nSELECT '${tag}';\n`);
    });
  }
  close() { this.markClosed(); this.child.stdin.end(); this.child.kill(); }
}
