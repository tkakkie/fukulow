export function revokeSessions(tokens: readonly string[], signOut: (token: string) => void): void {
  const failures: number[] = [];
  tokens.forEach((token, index) => {
    try {
      signOut(token);
    } catch {
      failures.push(index + 1);
    }
  });
  // Report positions only: credentials and response bodies must never reach artifacts.
  if (failures.length) throw new Error(`Session sign-out failed for ${failures.length} session(s): ${failures.join(', ')}`);
}
