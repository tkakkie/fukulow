// k6 includes setup_data (bearer credentials); never serialize the complete summary.
export function summaryForReport(data: unknown): Record<string, unknown> {
  const { metrics, options, state } = data as Record<string, unknown>;
  return { metrics, options, state };
}

export function requireSuccessfulRun(exitCode: number, summary: unknown): void {
  if (exitCode === 0) return;
  const { metrics } = (summary ?? {}) as {
    metrics?: Record<string, { thresholds?: Record<string, { ok: boolean }> }>;
  };
  const failed = Object.entries(metrics ?? {}).flatMap(([metric, data]) =>
    Object.entries(data.thresholds ?? {}).filter(([, result]) => result.ok === false)
      .map(([condition]) => `${metric}: ${condition}`));
  // Only threshold identities are diagnostic; setup_data and command output may contain credentials.
  throw new Error(`Invalid measurement: generator exited with code ${exitCode}; ${failed.length
    ? `failed thresholds: ${failed.join(', ')}` : 'no failed threshold details available (setup or execution failed)'}`);
}
