<script lang="ts">
  import { mentionKey, shouldFocusLatestMessageOnArrowUp, shouldSubmitOnEnter } from './composer-keys'
  import { focusTarget, submitAndFocusComposer } from './focus-management'
  import { tick } from 'svelte'
  import type { Member } from './api'
  import { mentionQuery, mentionCandidates, insertMention } from './mentions'
  import Button from './ui/Button.svelte'
  import Input from './ui/Input.svelte'
  import StatusBanner from './ui/StatusBanner.svelte'

  let {
    value,
    members = [],
    onmentionrequest,
    topicValue = '',
    allowTopicName = false,
    placeholder = 'メッセージを入力',
    submitDisabled = false,
    error = null,
    disabled = false,
    textareaRef = $bindable(null),
    topicInputRef = $bindable(null),
    oninput,
    ontopicinput,
    onsubmit,
    onarrowupempty,
  }: {
    value: string
    members?: readonly Member[]
    onmentionrequest?: () => void
    topicValue?: string
    allowTopicName?: boolean
    placeholder?: string
    submitDisabled?: boolean
    error?: string | null
    disabled?: boolean
    textareaRef?: HTMLInputElement | HTMLTextAreaElement | null
    topicInputRef?: HTMLInputElement | HTMLTextAreaElement | null
    oninput: (body: string) => void
    ontopicinput?: (topicName: string) => void
    onsubmit: () => Promise<boolean>
    onarrowupempty?: () => void
  } = $props()

  const id = $props.id()
  let caret = $state(0), active = $state(0), dismissed = $state(true)
  let listRef = $state<HTMLDivElement | null>(null)
  const query = $derived(!disabled && !dismissed ? mentionQuery(value, caret) : null)
  const candidates = $derived(query ? mentionCandidates(members, query.query) : [])
  const selected = $derived(Math.min(active, Math.max(0, candidates.length - 1)))
  $effect(() => {
    const option = listRef?.children[selected]
    if (option instanceof HTMLElement) option.scrollIntoView({ block: 'nearest' })
  })
  function selectCaret() {
    caret = textareaRef?.selectionStart ?? value.length
    active = 0
  }
  function input(body: string) {
    const opening = dismissed || query === null
    oninput(body)
    selectCaret()
    dismissed = false
    if (opening && mentionQuery(body, caret)) onmentionrequest?.()
  }
  async function choose(member: Member) {
    if (!query) return
    const next = insertMention(value, query, member)
    oninput(next.body); dismissed = true
    await tick()
    textareaRef?.focus()
    textareaRef?.setSelectionRange(next.caret, next.caret)
    caret = next.caret
  }

  function submit(e: Event) {
    e.preventDefault()
    if (disabled || submitDisabled) return
    submitAndFocusComposer(onsubmit, textareaRef)
  }

  function keydown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return
    const action = query ? mentionKey(e) : null
    if (action === 'dismiss') { e.preventDefault(); e.stopPropagation(); dismissed = true; return }
    if (action && candidates.length) {
      e.preventDefault()
      if (action === 'accept') void choose(candidates[selected])
      else active = (selected + (action === 'next' ? 1 : -1) + candidates.length) % candidates.length
      return
    }
    if (shouldSubmitOnEnter(e)) {
      submit(e)
      return
    }
    if (onarrowupempty && shouldFocusLatestMessageOnArrowUp(e, value, allowTopicName ? topicValue : '')) {
      e.preventDefault()
      onarrowupempty()
    }
  }

  function topicKeydown(e: KeyboardEvent) {
    if (!shouldSubmitOnEnter(e)) return
    e.preventDefault()
    if (disabled || submitDisabled) return
    if (value.trim()) {
      submit(e)
    } else {
      focusTarget(textareaRef)
    }
  }
</script>

<form class="composer" onsubmit={submit}>
  {#if allowTopicName}
    <Input
      bind:inputRef={topicInputRef}
      name="topic"
      ariaLabel="トピック名"
      placeholder="トピック名（任意）"
      {disabled}
      value={topicValue}
      oninput={(v) => ontopicinput?.(v)}
      onkeydown={topicKeydown}
    />
  {/if}
  <Input
    bind:inputRef={textareaRef}
    multiline
    rows={2}
    name="body"
    ariaLabel="メッセージ"
    {placeholder}
    {disabled}
    {value}
    oninput={input}
    onselect={selectCaret}
    onblur={() => { dismissed = true }}
    ariaControls={query && candidates.length ? `${id}-mentions` : undefined}
    ariaActiveDescendant={query && candidates.length ? `${id}-mention-${selected}` : undefined}
    onkeydown={keydown}
  />
  {#if query && candidates.length}
    <div bind:this={listRef} id={id + '-mentions'} role="listbox" aria-label="メンションするメンバー" class="composer__mentions">
      {#each candidates as member, index (member.id)}
        <button
          id={id + '-mention-' + index}
          type="button"
          role="option"
          aria-selected={index === selected}
          tabindex="-1"
          onpointerdown={(event) => { event.preventDefault(); void choose(member) }}
          onclick={() => void choose(member)}
        >{member.name}</button>
      {/each}
    </div>
  {/if}
  {#if error}
    <StatusBanner tone="danger" role="alert" message={error} />
  {/if}
  <div class="composer__actions">
    <Button variant="primary" type="submit" disabled={disabled || submitDisabled || !value.trim()}>送信</Button>
  </div>
</form>

<style>
  .composer {
    display: grid;
    gap: var(--space-8);
    padding: var(--space-12);
    background-color: var(--bg);
    border-radius: var(--radius-16);
    min-width: 0;
  }

  .composer__mentions {
    display: grid;
    max-height: 240px;
    overflow-y: auto;
    background: var(--surface);
    border-radius: var(--radius-8);
  }
  .composer__mentions button {
    min-height: var(--touch-target);
    border: 0;
    padding: var(--space-8) var(--space-12);
    background: var(--surface);
    color: var(--text);
    font-family: var(--font-sans);
    font-size: var(--font-size-15);
    text-align: left;
    overflow-wrap: anywhere;
  }
  .composer__mentions button[aria-selected='true'] { background: var(--tint); color: var(--on-tint); }
  .composer__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-8);
  }
</style>
