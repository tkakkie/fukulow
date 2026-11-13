import { createSubscriber } from 'svelte/reactivity'
import type { createAccountSecurity } from './account-security'

export function accountSecurityAdapter(controller: ReturnType<typeof createAccountSecurity>) {
  const subscribe = createSubscriber(update => controller.subscribe(update))
  return {
    get state() { subscribe(); return controller.get() },
    changePassword: controller.changePassword,
    revokeOthers: controller.revokeOthers,
    reset: controller.reset,
    close: controller.close,
  }
}
