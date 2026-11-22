import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appSessionArguments } from '../bench.ts';
import { timeouts } from '../runtime.ts';

// A single psql session makes exhaustive keyset pagination practical and keeps
// the prepared statement on the same connection across snapshots.
export async function withSession<T>(container: string, db: string, app: boolean,
  work: (sql: (text: string) => Promise<string>) => Promise<T>) {
  const child = spawn('docker', ['exec', '-i', ...(app ? appSessionArguments : []), container,
    'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', app ? 'fukulow_app' : 'fukulow', '-d', db]);
  const lines = createInterface({input: child.stdout})[Symbol.asyncIterator]();
  // Drain diagnostics without exposing SQL or credentials from the subprocess.
  child.stderr.resume();
  child.stdin.on('error', () => child.kill());
  const done = new Promise<number | null>(resolve => {
    child.on('error', () => resolve(null));
    child.on('close', resolve);
  });
  const marker = 'D3R_QUERY_DONE';
  let completed = false;
  try {
    const result = await work(async text => {
      const timer = setTimeout(() => child.kill('SIGKILL'), timeouts.psql);
      try {
        child.stdin.write(`${text}\n\\echo ${marker}\n`);
        const rows: string[] = [];
        for (;;) {
          const line = await lines.next();
          if (line.done) throw new Error('d3r psql stopped before completing the statement');
          if (line.value === marker) return rows.join('\n');
          rows.push(line.value);
        }
      } finally {
        clearTimeout(timer);
      }
    });
    completed = true;
    return result;
  } finally {
    child.stdin.end();
    if (!completed) child.kill();
    const code = await done;
    if (completed && code !== 0) throw new Error('d3r psql did not exit cleanly');
  }
}
