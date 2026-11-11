import { defineConfig } from '@playwright/test'

// Runs against an isolated real Docker Compose stack with an empty database.
// Set E2E_BASE_URL to its private HTTPS port; never reuse another task's stack or database.
// Caddy serves https://localhost with its internal CA, hence ignoreHTTPSErrors.
// Match the secret-safe failure policy of playwright.config.ts (#254).
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'

export default defineConfig({
  testDir: './e2e-compose',
  timeout: 60_000,
  workers: 1,
  preserveOutput: 'never',
  reporter: process.env.CI ? [['dot'], ['./scripts/e2e-reporter.ts']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://localhost', ignoreHTTPSErrors: true,
    trace: 'off', screenshot: 'off', video: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
