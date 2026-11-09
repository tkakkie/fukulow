// k6 includes setup_data (bearer credentials); never serialize the complete summary.
export function summaryForReport(data: unknown): Record<string, unknown> {
  const { metrics, options, state } = data as Record<string, unknown>;
  return { metrics, options, state };
}
