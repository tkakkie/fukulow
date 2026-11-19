<script lang="ts">
  import type { Message } from '../api'
  import type { MentionName } from '../mentions'
  import { tokenizeMessageBody, type InlineToken } from '../message-format'

  let {
    body,
    mentions = [],
    resolveMentionName,
    pending = false,
  }: {
    body: string
    mentions?: Message['mentions']
    resolveMentionName?: MentionName
    pending?: boolean
  } = $props()

  const blocks = $derived(tokenizeMessageBody(body, mentions, pending))
  const acceptedNames = $derived(
    new Map((mentions ?? []).map((target) => [target.member_id, target.name])),
  )

  function formatMention(id: string): string {
    const fallback = acceptedNames.get(id)
    if (fallback === undefined) return `@{member:${id}}`
    return `@${resolveMentionName?.(id, fallback, mentions) ?? fallback}`
  }
</script>

{#snippet renderInline(tokens: InlineToken[])}{#each tokens as token}{#if token.type === 'text'}{token.text}{:else if token.type === 'mention'}<span class="ui-message-body__mention">{formatMention(token.id)}</span>{:else if token.type === 'code'}<code class="ui-message-body__inline-code">{#each token.children as child}{#if child.type === 'text'}{child.text}{:else}<span class="ui-message-body__mention">{formatMention(child.id)}</span>{/if}{/each}</code>{:else if token.type === 'link'}<a
  class="ui-message-body__link"
  href={token.href}
  target="_blank"
  rel="noopener noreferrer"
>{token.text}</a>{:else if token.type === 'bold'}<strong class="ui-message-body__bold">{@render renderInline(token.children)}</strong>{:else if token.type === 'strikethrough'}<del class="ui-message-body__strike">{@render renderInline(token.children)}</del>{/if}{/each}{/snippet}

<div class="body ui-message-body">{#each blocks as block, i}{#if i > 0 && block.type === 'line' && blocks[i - 1].type === 'line'}{'\n'}{/if}{#if block.type === 'line'}{@render renderInline(block.children)}{:else if block.type === 'code_block'}<pre class="ui-message-body__code-block"><code>{#each block.children as child}{#if child.type === 'text'}{child.text}{:else}<span class="ui-message-body__mention">{formatMention(child.id)}</span>{/if}{/each}</code></pre>{:else if block.type === 'quote'}<blockquote class="ui-message-body__quote">{#each block.lines as line, lineIdx}{#if lineIdx > 0}{'\n'}{/if}{@render renderInline(line)}{/each}</blockquote>{/if}{/each}</div>

<style>
  .ui-message-body {
    min-width: 0;
  }

  .ui-message-body__link {
    color: var(--link);
    text-decoration: underline;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .ui-message-body__inline-code {
    padding: 0 var(--space-4);
    border-radius: var(--radius-8);
    background-color: var(--bg);
    border: 1px solid var(--border);
    font-size: var(--font-size-13);
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .ui-message-body__code-block {
    margin: var(--space-4) 0;
    padding: var(--space-8) var(--space-12);
    border-radius: var(--radius-8);
    background-color: var(--bg);
    border: 1px solid var(--border);
    font-size: var(--font-size-13);
    line-height: var(--line-height-base);
    white-space: pre;
    overflow-x: auto;
    max-width: 100%;
    min-width: 0;
  }

  .ui-message-body__quote {
    margin: var(--space-4) 0;
    padding: var(--space-4) var(--space-12);
    border-left: var(--space-4) solid var(--border-input);
    color: var(--text2);
    min-width: 0;
  }

  .ui-message-body__bold {
    font-weight: var(--font-weight-semibold);
  }
</style>
