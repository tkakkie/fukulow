import { createSubscriber } from 'svelte/reactivity'
import { getUiSettings, type UiSettingsController } from './ui-settings'

export function uiSettingsAdapter(controller: UiSettingsController = getUiSettings()) {
  const subscribe = createSubscriber((update) => controller.subscribe(update))
  return {
    get state() {
      subscribe()
      return controller.get()
    },
    setTheme: controller.setTheme,
    setTextSize: controller.setTextSize,
  }
}
