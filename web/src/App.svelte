<script lang="ts">
  import { checkHealth } from './api'

  let status = $state('接続を確認中…')
  checkHealth().then((ok) => (status = ok ? 'サーバーに接続しました' : 'サーバーに接続できません'))
</script>

<main>
  <h1>fukulow</h1>
  <p>{status}</p>
</main>
