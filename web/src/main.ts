import { mount, unmount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initUiSettings } from './ui-settings'
import { initCore } from '#sync-core'
import { bootstrap } from './bootstrap'

initUiSettings()

const target = document.getElementById('app')!
void bootstrap(initCore, () => mount(App, { target }), app => {
  void unmount(app)
  target.setAttribute('role', 'alert')
  target.textContent = 'アプリを起動できませんでした。ページを再読み込みしてください。'
})
