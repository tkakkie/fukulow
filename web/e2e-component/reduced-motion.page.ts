// Test page for e2e-component/reduced-motion.spec.ts (#839): mounts the real Panel (`.ui-panel`) and
// Badge (`.ui-badge`) with real `app.css` and no server, database or wasm imports.
import { mount } from 'svelte'
import '../src/app.css'
import Badge from '../src/ui/Badge.svelte'
import Panel from '../src/ui/Panel.svelte'

const target = document.getElementById('app')!
const panelHost = document.createElement('div')
const badgeHost = document.createElement('div')
target.append(panelHost, badgeHost)

mount(Panel, {
  target: panelHost,
  props: {
    title: '# general',
    activeTab: 'topics',
  },
})

mount(Badge, {
  target: badgeHost,
  props: {
    kind: 'unread',
    count: 3,
  },
})
