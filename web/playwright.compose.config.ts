import { defineConfig } from '@playwright/test'

// Runs against an isolated real Docker Compose stack with an empty database.
// Set E2E_BASE_URL to its private HTTPS port; never reuse another task's stack or database.
// Caddy serves https://localhost with its internal CA, hence ignoreHTTPSErrors.
export default defineConfig({
  testDir: './e2e-compose',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: process.env.E2E_BASE_URL ?? 'https://localhost', ignoreHTTPSErrors: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
