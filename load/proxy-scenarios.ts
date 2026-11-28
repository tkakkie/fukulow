// proxy-measure.yml `plan`: one matrix entry per scenario; 6 (resource collection) expands to 2, 3 and 4.
import { appendFileSync } from 'node:fs';

export function expandScenarios(input: string): number[] {
  const listed = input.split(',').map(Number);
  if (!listed.length || !listed.every(n => Number.isInteger(n) && n >= 1 && n <= 6)) throw new Error('scenarios must be comma-separated 1..6');
  // Default (string) order equals numeric order for the single digits 1..5 left after expansion.
  return [...new Set(listed.flatMap(n => n === 6 ? [2, 3, 4] : [n]))].sort();
}

export function outputLine(scenarios: number[]): string {
  return 'scenarios=' + JSON.stringify(scenarios) + '\n';
}

if (import.meta.main) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is not set');
  appendFileSync(output, outputLine(expandScenarios(process.env.SCENARIOS ?? '')));
}
