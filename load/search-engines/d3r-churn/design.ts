import { accepts } from '../d3r/acceptance.ts';
import { manifestFile as baseManifest } from '../d3r/manifest.ts';
import { readSource } from '../d3r/path.ts';
import { seed } from '../seed.ts';

export const sourceCommit = 'c69aff667cfb38d2dfec92d4c09e364e44219310';
export const base = JSON.parse(readSource(baseManifest)).frozen as ReturnType<typeof import('../d3r/manifest.ts').snapshot>;
export const queries = base.performance.querySet.filter(([id]) => accepts(id));
export const db = 'fukulow';
export const modelLabel = 'W2 MODEL';
export const sampleSeconds = 300;
export const full = { rows: 1_000_000, rate: 50, sendSeconds: 3600, modelSeconds: 3600, idleSeconds: 1800,
  editPercent: 10, deletePercent: 5, modelSessions: 8, clients: 5, transactions: 20, seed } as const;
export const appSettings = { FUKULOW_SEARCH_ENGINE: 'disabled', FUKULOW_ADDR: '0.0.0.0:8080', FUKULOW_COOKIE_SECURE: 'false',
  FUKULOW_SEND_BURST: '1000000', FUKULOW_SEND_REFILL_PER_SECOND: '1000000' };
export const sessionOverrides = { sqlApp: { jit: 'off', statement_timeout: '10s' },
  searchTransaction: { plan_cache_mode: 'force_generic_plan', statement_timeout: '2s' },
  termBackfillTransaction: { statement_timeout: '0' },
  fixtureRlsProbeSession: { statement_timeout: '0' } };
export const k6Reference = 'grafana/k6:2.4.0@sha256:d41bb79cd8de5a7ad619b53570e3712633e8bff0937010a5c6c57a4747e7a276';
export const stages = {
  smoke: 'SMOKE / NOT EVIDENCE',
  rehearsal: 'REHEARSAL / NOT EVIDENCE',
  formal: 'FORMAL / REPORT ONLY',
} as const;
export type Stage = keyof typeof stages;
