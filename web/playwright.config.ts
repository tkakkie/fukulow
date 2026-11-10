import { defineConfig } from '@playwright/test'

// The Rust binary serves the built app (web/dist is embedded at cargo build time).
const port = 18080

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: '../target/debug/fukulow-server',
    url: `http://127.0.0.1:${port}/api/v1/health`,
    env: { FUKULOW_ADDR: `127.0.0.1:${port}` },
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
