import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { precompress } from './scripts/precompress.ts'
import { checkCoreBundle } from './scripts/core-bundle.ts'
import { bundlePackages, checkBundlePackages, denyAllowList } from './scripts/bundle-licenses.ts'
import { readFileSync, writeFileSync } from 'node:fs'
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
      // #807: npm packages in the shipped bundle must have an allowed license; the list feeds THIRD-PARTY-NOTICES.
      { name: 'bundle-licenses', apply: 'build', generateBundle(_options, bundle) {
        const root = fileURLToPath(new URL('.', import.meta.url))
        const ids = Object.values(bundle).flatMap(item => item.type === 'chunk' ? Object.keys(item.modules)
          : item.originalFileNames.map(name => resolve(root, name)))
        const packages = bundlePackages(ids, root, name => root + 'node_modules/' + name)
        checkBundlePackages(packages, denyAllowList(readFileSync(new URL('../deny.toml', import.meta.url), 'utf8')))
        writeFileSync(new URL('./bundle-licenses.json', import.meta.url), JSON.stringify(packages, null, 1) + '\n')
      } },
      svelte({
        // Vitest runs in Node, which Vite treats as SSR: `.svelte.ts` modules would compile with `generate: 'server'`,
        // where `$effect` never runs. Compile for the client instead, so adapters run like in the browser.
        dynamicCompileOptions: () => (test ? { generate: 'client' } : undefined),
      }),
    ],
    // Same reason for the runtime: resolve svelte's browser build (it needs no DOM) instead of its server build.
    ssr: { resolve: { conditions: test ? ['browser', 'module', 'node', 'development|production'] : undefined } },
    test: {
      setupFiles: ['./scripts/init-wasm.ts'],
      // Timing-ratio tests run after every other file, one file at a time: other test files running
      // in parallel inflate their ratios (#753).
      projects: [
        { extends: true, test: { name: 'unit', exclude: ['e2e/**', 'e2e-compose/**', 'e2e-component/**', 'node_modules/**', PERF_TESTS], sequence: { groupOrder: 0 } } },
        { extends: true, test: { name: 'perf', include: [PERF_TESTS], fileParallelism: false, sequence: { groupOrder: 1 } } },
      ],
    },
  }
})
