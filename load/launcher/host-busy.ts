export function formatHostBusy(queue: string, jobs: readonly string[], at: Date, session: string): string {
  return `${queue}: ${jobs.join(', ')} ${at.toISOString()} session ${session}\n`;
}

export function parseHostBusy(line: string): { jobs: string[]; session: string } | null {
  const match = /^[^\r\n]+: ([\w.-]+(?:, [\w.-]+)*) (?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z session (\S+)\n$/.exec(line);
  return match ? { jobs: match[1].split(', '), session: match[2] } : null;
}
