import { fileURLToPath } from 'node:url'
import { precompress } from './scripts/precompress.ts'
import { checkCoreBundle } from './scripts/core-bundle.ts'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

const PERF_TESTS = 'src/**/*.perf.test.ts'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const test = mode === 'test'
  return {
    build: { manifest: true, assetsInlineLimit: 0, rollupOptions: { output: {
      manualChunks: id => id.endsWith('/wasm/fukulow_client_core.js') ? 'sync-wasm' : undefined,
    } } },
    resolve: { alias: [
      { find: '#sync-core', replacement: fileURLToPath(new URL('./src/core-wasm.ts', import.meta.url)) },
      ...(test ? [{ find: /^\.\/core-values$/, replacement: fileURLToPath(new URL('./scripts/core-test-values.ts', import.meta.url)) }] : []),
    ] },
    plugins: [
      { name: 'precompressed-brotli', apply: 'build',
        async writeBundle(options) {
          if (!options.dir) throw new Error('Brotli assets require an output directory')
          await precompress(options.dir)
        },
      },
      { name: 'single-sync-implementation', generateBundle(_options, bundle) {
        checkCoreBundle(Object.values(bundle).flatMap(chunk => chunk.type === 'chunk' ? Object.keys(chunk.modules) : []),
          Object.values(bundle).filter(chunk => chunk.type === 'asset').map(asset => asset.fileName))
      } },
      svelte({
        // Vitest runs in Node, which Vite treats as SSR: `.svelte.ts` modules would compile with `generate: 'server'`,
        // where `$effect` never runs. Compile for the client instead, so adapters run like in the browser.
        dynamicCompileOptions: () => (test ? { generate: 'client' } : undefined),
      }),
    ],
    // Same reason for the runtime: resolve svelte's browser build (it needs no DOM) instead of its server build.
    ssr: { resolve: { conditions: test ? ['browser', 'module', 'node', 'development|production'] : undefined } },
    // Timing-ratio tests run alone in a second pass (`npm run test:perf`): other test files running in
    // parallel inflate their ratios (#753).
    test: process.env.FUKULOW_PERF_TESTS === '1'
      ? { setupFiles: ['./scripts/init-wasm.ts'], include: [PERF_TESTS], fileParallelism: false }
      : { setupFiles: ['./scripts/init-wasm.ts'], exclude: ['e2e/**', 'e2e-compose/**', 'node_modules/**', PERF_TESTS] },
  }
})
