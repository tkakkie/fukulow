// Deterministic pair selection keeps each sender at <=1/s at 2,000 offered/s.
export function senderFor(iteration: number, members = 2000): number {
  if (!Number.isSafeInteger(iteration) || iteration < 0 || members < 2 || members % 2 !== 0) throw new Error('Invalid sender schedule');
  return iteration % members;
}

export function senderIndex(iteration: number, shard: number, members: number): number {
  return Math.floor(members / 4) * shard + senderFor(iteration, 500);
}

export function socketStop(start: number, ready: number, sendStartSeconds: number, seconds: number, rate: number): number {
  return rate ? Math.max(ready, start + (sendStartSeconds + seconds + 10) * 1000) : ready + seconds*1000;
}

export function regularPairs(members: number, degree: number): [number, number][] {
  if (degree%2 || degree < 2 || degree >= members) throw new Error('Degree must be positive, even and below Member count');
  const result: [number, number][] = [];
  for (let i = 0; i < members; i++) for (let d = 1; d <= degree/2; d++) {
    const j = (i+d)%members;
    result.push([Math.min(i,j), Math.max(i,j)]);
  }
  return result;
}

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

export function outsideCheckout(output: string, checkout: string): boolean {
  return output !== checkout && !output.startsWith(checkout + '/');
}
