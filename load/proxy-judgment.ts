export type Proxy = 'caddy' | 'nginx';
export type Tls = { protocol: string; cipher: string; alpn: string };
export type Observation = {
  proxy: Proxy; value: number; tls: Tls[]; generatorCpu: number | null;
  error?: string;
};
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { min: sorted[0], max: sorted.at(-1)!, median,
    spread: median === 0 ? (sorted.at(-1) === 0 ? 0 : Infinity) : (sorted.at(-1)! - sorted[0]) / median };
}
export function judge(rows: Observation[], kind: 'latency' | 'step' | 'descriptive', generatorGate = false) {
  const invalid: { index: number; reasons: string[] }[] = [];
  const signature = (row: Observation) => JSON.stringify(row.tls.map(({ protocol, cipher }) => ({ protocol, cipher })));
  const indexed = (proxy: Proxy) => rows.flatMap((row, index) => row.proxy === proxy ? [{ row, index }] : []);
  const caddyRuns = indexed('caddy'), nginxRuns = indexed('nginx');
  const tlsMismatches = new Set<number>();
  // Pair the nth measured run of each proxy, regardless of ABBA execution order.
  for (let i = 0; i < Math.min(caddyRuns.length, nginxRuns.length); i++) {
    if (signature(caddyRuns[i].row) !== signature(nginxRuns[i].row)) {
      tlsMismatches.add(caddyRuns[i].index); tlsMismatches.add(nginxRuns[i].index);
    }
  }
  const valid = rows.filter((row, index) => {
    const reasons = [
      ...(row.error ? [row.error] : []),
      ...(!Number.isFinite(row.value) || row.value < 0 ? ['missing/invalid metric'] : []),
      ...(row.tls.length !== 2 || row.tls.some(t => t.protocol !== 'TLSv1.3' || !t.cipher || !t.alpn) ? ['missing/TLS 1.3 negotiation'] : []),
      ...(tlsMismatches.has(index) ? ['TLS protocol/cipher mismatch'] : []),
      ...(generatorGate && (row.generatorCpu === null || row.generatorCpu >= 90) ? ['generator-bound or missing generator CPU'] : []),
    ];
    if (reasons.length) invalid.push({ index, reasons });
    return reasons.length === 0;
  });
  const values = (proxy: Proxy) => valid.filter(row => row.proxy === proxy).map(row => row.value);
  const c = values('caddy'), n = values('nginx');
  if (c.length !== 5 || n.length !== 5) return { verdict: 'inconclusive', invalid, counts: { caddy: c.length, nginx: n.length } };
  const caddy = distribution(c), nginx = distribution(n);
  const difference = caddy.max < nginx.min || nginx.max < caddy.min ? 'difference' : 'no difference';
  // Plan: step metrics are decidable when every run reaches the same step, or the
  // step order between proxies is consistent (non-overlapping ranges).
  const noisy = kind === 'step' ? difference === 'no difference' && (caddy.min !== caddy.max || nginx.min !== nginx.max)
    : kind === 'latency' && (caddy.spread > 0.05 || nginx.spread > 0.05);
  const verdict = kind === 'descriptive' ? 'descriptive' : noisy ? 'inconclusive'
    : difference === 'no difference' || (kind === 'step' ? nginx.median >= caddy.median : nginx.median <= caddy.median * 1.05) ? 'pass' : 'fail';
  return { verdict, difference, caddy, nginx, invalid };
}
export function abba(repetitions: number): Proxy[] {
  const order: Proxy[] = [];
  const counts = { caddy: 0, nginx: 0 };
  for (let block = 0; counts.caddy < repetitions || counts.nginx < repetitions; block++) {
    for (const proxy of (block % 2 ? ['nginx', 'caddy', 'caddy', 'nginx'] : ['caddy', 'nginx', 'nginx', 'caddy']) as Proxy[]) {
      if (counts[proxy] < repetitions) { order.push(proxy); counts[proxy]++; }
    }
  }
  return order;
}
