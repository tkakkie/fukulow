import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { initUiSettings } from './ui-settings'
import { initCore } from '#sync-core'
import { bootstrap } from './bootstrap'

initUiSettings()

void bootstrap(initCore, () => {
  mount(App, { target: document.getElementById('app')! })
}, () => {
  const target = document.getElementById('app')!
  target.setAttribute('role', 'alert')
  target.textContent = 'アプリを起動できませんでした。ページを再読み込みしてください。'
})
