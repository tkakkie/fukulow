import { defineConfig } from '@playwright/test'

// Sprint 1 acceptance: runs against the real Docker Compose stack started from an empty database:
//   docker compose --profile caddy down -v && docker compose --profile caddy up -d --build
// Caddy serves https://localhost with its internal CA, hence ignoreHTTPSErrors.
export default defineConfig({
  testDir: './e2e-compose',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'https://localhost', ignoreHTTPSErrors: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
