import { flushSync, tick } from 'svelte'
import { expect, it } from 'vitest'

// Proves the vitest setup (vite.config.ts + test/client-environment.ts): runes compile in `.svelte.test.ts`
// files, and effects really run in Node without a DOM.
it('runs runes outside components: $state, $derived and $effect.root with flushSync', async () => {
  let count = $state(0)
  const double = $derived(count * 2)
  const seen: number[] = []
  const stop = $effect.root(() => {
    $effect(() => { seen.push(double) })
  })
  // The first run of a root's effects is a microtask: `flushSync` alone does not run it yet.
  await tick()
  expect(seen).toEqual([0])
  count = 2
  flushSync()
  expect(seen).toEqual([0, 4])
  stop()
  count = 3
  flushSync()
  expect(seen).toEqual([0, 4])
})

it('uses the client runtime: flushSync is not the no-op of the server build', () => {
  let ran = false
  flushSync(() => { ran = true })
  expect(ran).toBe(true)
  const state = $state({ n: 1 })
  expect($state.snapshot(state)).toEqual({ n: 1 })
})
