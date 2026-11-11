<script lang="ts">
  let {
    label,
    ariaLabel,
    name,
    type = 'text',
    value = $bindable(''),
    placeholder,
    required = false,
    disabled = false,
    minlength,
    maxlength,
    autocomplete,
    multiline = false,
    rows = 2,
    hint,
    inputRef = $bindable(null),
    oninput,
    onkeydown,
  }: {
    label?: string
    ariaLabel?: string
    name?: string
    type?: 'text' | 'email' | 'password' | 'search'
    value?: string
    placeholder?: string
    required?: boolean
    disabled?: boolean
    minlength?: number
    maxlength?: number
    autocomplete?: AutoFill
    multiline?: boolean
    rows?: number
    hint?: string
    inputRef?: HTMLInputElement | HTMLTextAreaElement | null
    oninput?: (value: string, event: Event) => void
    onkeydown?: (event: KeyboardEvent) => void
  } = $props()

  function handleInput(e: Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement }) {
    value = e.currentTarget.value
    oninput?.(e.currentTarget.value, e)
  }
</script>

{#if label}
  <label class="ui-field">
    <span class="ui-field__label">{label}</span>
    {#if multiline}
      <textarea
        bind:this={inputRef}
        class="ui-input ui-input--textarea"
        {name}
        {rows}
        {placeholder}
        {required}
        {disabled}
        {minlength}
        {maxlength}
        {value}
        oninput={handleInput}
        {onkeydown}
      ></textarea>
    {:else}
      <input
        bind:this={inputRef}
        class="ui-input"
        {name}
        {type}
        {placeholder}
        {required}
        {disabled}
        {minlength}
        {maxlength}
        {autocomplete}
        {value}
        oninput={handleInput}
        {onkeydown}
      />
    {/if}
    {#if hint}
      <small class="ui-field__hint">{hint}</small>
    {/if}
  </label>
{:else if multiline}
  <textarea
    bind:this={inputRef}
    class="ui-input ui-input--textarea"
    aria-label={ariaLabel}
    {name}
    {rows}
    {placeholder}
    {required}
    {disabled}
    {minlength}
    {maxlength}
    {value}
    oninput={handleInput}
    {onkeydown}
  ></textarea>
{:else}
  <input
    bind:this={inputRef}
    class="ui-input"
    aria-label={ariaLabel}
    {name}
    {type}
    {placeholder}
    {required}
    {disabled}
    {minlength}
    {maxlength}
    {autocomplete}
    {value}
    oninput={handleInput}
    {onkeydown}
  />
{/if}

<style>
  .ui-field {
    display: grid;
    gap: var(--space-4);
    min-width: 0;
    width: 100%;
  }

  .ui-field__label {
    font-size: var(--font-size-14);
    font-weight: var(--font-weight-medium);
    color: var(--text);
  }

  .ui-field__hint {
    font-size: var(--font-size-12);
    color: var(--muted);
  }

  .ui-input {
    width: 100%;
    min-width: 0;
    min-height: var(--touch-target);
    padding: var(--space-8) var(--space-12);
    background-color: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-input);
    border-radius: var(--radius-8);
    font-family: var(--font-sans);
    font-size: var(--font-size-15);
    line-height: var(--line-height-base);
  }

  .ui-input::placeholder {
    color: var(--muted);
  }

  .ui-input:disabled {
    background-color: var(--bg);
    color: var(--muted);
    cursor: not-allowed;
  }

  .ui-input--textarea {
    resize: vertical;
    line-height: var(--line-height-message);
  }
</style>
