import { defineConfig } from '@playwright/test'

// The Rust binary serves the built app (web/dist is embedded at cargo build time).
const port = Number(process.env.E2E_PORT ?? 18080)
// CI: 4 workers, matching E2E_WORKERS in e2e.yml, which creates one database per worker.
// The checked smoke command passes no extra env into the container. Local runs default to 1.
const workerCount = Number(process.env.E2E_WORKERS ?? (process.env.CI ? 4 : 1))
if (!Number.isInteger(workerCount) || workerCount < 1) throw new Error('E2E_WORKERS must be a positive integer')
const parallelIndex = Number(process.env.TEST_PARALLEL_INDEX ?? 0)

// Worker 0 uses DATABASE_URL as-is so single-DB local runs work without extra databases.
// Additional workers connect to `<db>_w<index>` on the same Postgres service.
function workerDatabaseUrl(baseUrl: string | undefined, index: number): string | undefined {
  if (!baseUrl || index === 0) return baseUrl
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname}_w${index}`
  return url.toString()
}

// Playwright 1.65 otherwise captures the whole page on failure, even with trace off.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'

export default defineConfig({
  testDir: './e2e',
  workers: workerCount,
  timeout: 30_000,
  // Locator failures can still supply ARIA contexts. Retain no raw per-test output;
  // the reporter writes its allowlisted report separately after test cleanup.
  preserveOutput: 'never',
  reporter: process.env.CI ? [['dot'], ['./scripts/e2e-reporter.ts']] : 'list',
  use: { baseURL: `http://127.0.0.1:${port + parallelIndex}`, trace: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: Array.from({ length: workerCount }, (_, index) => {
    const serverPort = port + index
    const databaseUrl = workerDatabaseUrl(process.env.DATABASE_URL, index)
    return {
      command: '../target/debug/fukulow-server',
      url: `http://127.0.0.1:${serverPort}/api/v1/health`,
      env: {
        ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
        FUKULOW_ADDR: `127.0.0.1:${serverPort}`,
        FUKULOW_COOKIE_SECURE: 'false',
        FUKULOW_SEARCH_ENGINE: 'd3r',
        FUKULOW_SETUP_TOKEN: process.env.E2E_SETUP_TOKEN ?? 'playwright-setup-test-only',
        ...(workerCount > 1 ? { FUKULOW_DB_MAX_CONNECTIONS: '10' } : {}),
      },
      reuseExistingServer: false,
      timeout: 30_000,
      // The server logs no request headers/bodies; see auth.rs and main.rs.
      stdout: process.env.CI ? 'pipe' : 'ignore',
      stderr: 'pipe',
    }
  }),
})
