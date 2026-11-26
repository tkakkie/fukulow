import { resolve } from 'node:path';
import type { CatalogSettle } from './c3-catalog-settle.ts';
import { dump } from './c3-runtime.ts';

export function settleRecorder(output: string, manifest: Record<string, unknown>, settles: CatalogSettle[], windowDir?: string) {
  return (evidence: CatalogSettle) => {
    if (!settles.includes(evidence)) settles.push(evidence);
    dump(resolve(output, 'manifest.json'), { ...manifest, catalogSettles: settles });
    if (windowDir) dump(resolve(windowDir, 'catalog-settle.json'), evidence);
  };
}
