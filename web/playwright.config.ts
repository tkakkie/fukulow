import { defineConfig } from '@playwright/test'

// The Rust binary serves the built app (web/dist is embedded at cargo build time).
const port = Number(process.env.E2E_PORT ?? 18080)

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 30_000,
  reporter: process.env.CI ? [['dot'], ['./scripts/e2e-reporter.ts']] : 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: '../target/debug/fukulow-server',
    url: `http://127.0.0.1:${port}/api/v1/health`,
    env: {
      FUKULOW_ADDR: `127.0.0.1:${port}`,
      FUKULOW_COOKIE_SECURE: 'false',
      FUKULOW_SETUP_TOKEN: process.env.E2E_SETUP_TOKEN ?? 'playwright-setup-test-only',
    },
    reuseExistingServer: false,
    timeout: 30_000,
    // The server logs no request headers/bodies; see auth.rs and main.rs.
    stdout: process.env.CI ? 'pipe' : 'ignore',
    stderr: 'pipe',
  },
})
