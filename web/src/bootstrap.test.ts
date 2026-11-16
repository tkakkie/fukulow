import { expect, it, vi } from 'vitest'
import { bootstrap } from './bootstrap'
it('mounts the shell while the core loads, starts the load first and fails only on a load error', async () => {
  const order: string[] = []
  let ready!: () => void
  const fail = vi.fn()
  const boot = bootstrap(() => { order.push('init'); return new Promise<void>(resolve => { ready = resolve }) },
    () => { order.push('mount'); return 'app' }, fail)
  expect(order).toEqual(['init', 'mount'])
  ready(); await boot
  expect(fail).not.toHaveBeenCalled()
  await bootstrap(() => Promise.reject(new Error('invalid wasm')), () => 'shell', fail)
  expect(fail).toHaveBeenCalledExactlyOnceWith('shell')
})
