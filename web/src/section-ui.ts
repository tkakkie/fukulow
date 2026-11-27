import { isSessionEnded } from './api'
import type { SectionResult } from './sections'

/** Max section name length in Unicode scalar values (spec R1). */
export const SECTION_NAME_MAX = 60

export const OTHER_CHANNELS_LABEL = 'その他のチャンネル'
export const IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL = `${OTHER_CHANNELS_LABEL}（既定）`

// Rust `str::trim()` strips Unicode `White_Space` (`char::is_whitespace`), which includes U+0085 (NEL)
// and excludes U+FEFF (BOM), unlike JS `String.prototype.trim()`.
const RUST_WHITESPACE_ONLY = /^\p{White_Space}+$/u
const RUST_SURROUNDING_WHITESPACE = /^\p{White_Space}|\p{White_Space}$/u
const RUST_WHITESPACE_RUN = /\p{White_Space}+/gu

/**
 * Normalizes a label to the whitespace-collapsed form users see and hear:
 * collapses every run of Unicode `White_Space` to a single ASCII space and trims the ends.
 */
export function normalizeRenderedSectionLabel(label: string): string {
  return label.replace(RUST_WHITESPACE_RUN, ' ').replace(/^ | $/g, '')
}

/**
 * Validates a personal section name against spec R1 without trimming or normalizing:
 * 1..=60 decoded Unicode scalars, no NUL, no surrounding Rust `str::trim()` whitespace,
 * and at least one non-whitespace scalar.
 */
export function validateSectionName(name: string): string | null {
  if (name.length === 0 || RUST_WHITESPACE_ONLY.test(name)) {
    return 'セクション名を入力してください。'
  }
  if (RUST_SURROUNDING_WHITESPACE.test(name)) {
    return 'セクション名の前後に空白は入れられません。空白を取り除いて入力してください。'
  }
  if (name.includes('\0')) {
    return 'セクション名に使用できない文字が含まれています。別の名前を入力してください。'
  }
  if ([...name].length > SECTION_NAME_MAX) {
    return `セクション名は${SECTION_NAME_MAX}文字以内で入力してください。`
  }
  return null
}

export type MoveDestinationOption = {
  id: string | null
  label: string
}

/**
 * Builds distinguishable visible and accessible labels for move destinations (`docs/spec/sections.md` Q2).
 * Always identifies the implicit Other Channels group and disambiguates duplicate custom names
 * (including a custom section named `その他のチャンネル`).
 */
export function buildMoveDestinations(
  customSections: readonly { id: string; name: string }[],
): MoveDestinationOption[] {
  const otherKey = normalizeRenderedSectionLabel(OTHER_CHANNELS_LABEL)
  const implicitKey = normalizeRenderedSectionLabel(IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL)
  const counts = new Map<string, number>([
    [otherKey, 1],
    [implicitKey, 1],
  ])
  for (const s of customSections) {
    const key = normalizeRenderedSectionLabel(s.name)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const taken = new Set<string>([otherKey, implicitKey])
  for (const s of customSections) {
    const key = normalizeRenderedSectionLabel(s.name)
    if ((counts.get(key) ?? 0) === 1) {
      taken.add(key)
    }
  }
  const seen = new Map<string, number>()
  const options: MoveDestinationOption[] = customSections.map((s) => {
    const key = normalizeRenderedSectionLabel(s.name)
    if ((counts.get(key) ?? 0) === 1) {
      return { id: s.id, label: s.name }
    }
    let occ = (seen.get(key) ?? 0) + 1
    let label = `${s.name}（${occ}番目）`
    let candidateKey = normalizeRenderedSectionLabel(label)
    while (taken.has(candidateKey)) {
      occ++
      label = `${s.name}（${occ}番目）`
      candidateKey = normalizeRenderedSectionLabel(label)
    }
    seen.set(key, occ)
    taken.add(candidateKey)
    return { id: s.id, label }
  })
  options.push({ id: null, label: IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL })
  return options
}

/** Polite Japanese message with a recovery step for a failed section mutation (`docs/ui.md` §10, `docs/spec/sections.md`). */
export function sectionWriteError(result: Extract<SectionResult<unknown>, { ok: false }>): string {
  if (result.kind === 'busy') {
    return '別のセクション操作を実行中です。完了してからもう一度お試しください。'
  }
  if (result.kind === 'reconciling') {
    return '最新のセクション一覧を確認しています。少し待ってからもう一度お試しください。'
  }
  if (result.kind === 'inactive') {
    return '現在はセクションを変更できません。画面を確認してからもう一度お試しください。'
  }
  if (result.kind === 'network') {
    if (result.error === 'lock_contention') {
      return '他の更新と重なったため完了できませんでした。少し待ってからもう一度お試しください。'
    }
    return '更新を確認できませんでした。最新のセクション一覧を確認してから、必要に応じてやり直してください。'
  }
  if (result.kind !== 'http') {
    return 'セクションを更新できませんでした。少し待ってからもう一度お試しください。'
  }
  if (result.error === 'lock_contention') {
    return '他の更新と重なったため完了できませんでした。少し待ってからもう一度お試しください。'
  }
  if (isSessionEnded(result)) {
    return 'ログインの有効期限が切れました。もう一度ログインしてください。'
  }
  if (result.status === 404 && result.error === 'organization_unavailable') {
    return 'この組織は利用できません。組織の選択画面から確認してください。'
  }
  if (result.status === 400 && result.error === 'invalid_section_name') {
    return `セクション名の前後に空白を入れず、${SECTION_NAME_MAX}文字以内で入力してください。`
  }
  if (result.status === 400 && result.error === 'invalid_section_order') {
    return '並び替えの情報が正しくありません。最新の状態を確認して、もう一度お試しください。'
  }
  if (result.status === 404 && result.error === 'section_not_found') {
    return '対象のセクションが見つかりませんでした。最新の状態を確認して、もう一度お試しください。'
  }
  if (result.status === 404 && result.error === 'channel not found') {
    return 'このチャンネルは利用できません。チャンネル一覧を確認してください。'
  }
  if (result.status === 409 && result.error === 'channel_archived') {
    return 'アーカイブ済みのチャンネルはセクションに移動できません。復元してからお試しください。'
  }
  if (result.status === 409 && result.error === 'section_limit') {
    return 'セクション数の上限（50件）に達しています。不要なセクションを削除してから作成してください。'
  }
  if (result.status === 409 && result.error === 'section_deleted') {
    return 'このセクションはすでに削除されています。最新の状態を確認して、新しく作成してください。'
  }
  if (result.status === 409 && result.error === 'section_id_conflict') {
    return '同じ識別子のセクションがすでに存在します。もう一度作成をお試しください。'
  }
  if (result.status === 409 && result.error === 'section_layout_changed') {
    return '別の操作でセクション一覧が更新されました。最新の状態を確認して、もう一度お試しください。'
  }
  return 'セクションを更新できませんでした。少し待ってからもう一度お試しください。'
}

/** Returns a new array with the element at `index` swapped one step up or down, or null if out of bounds. */
export function reorderList<T>(items: readonly T[], index: number, direction: 'up' | 'down'): T[] | null {
  const target = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return null
  const next = [...items]
  const [moved] = next.splice(index, 1)
  next.splice(target, 0, moved)
  return next
}

export type DeleteFocusTarget =
  | { kind: 'section'; id: string }
  | { kind: 'other' }
  | { kind: 'channel-list' }

/**
 * Computes the ordered focus fallback targets after a section is deleted, resolving the first
 * surviving next neighbor, then Other Channels (when visible), then the first surviving previous
 * neighbor, then the Channel-list heading against the reconciled layout (`docs/spec/sections.md`).
 */
export function resolveDeleteFocusTargets(
  currentCustomIds: readonly string[],
  nextSectionIds: readonly string[],
  prevSectionIds: readonly string[],
  otherIsVisible: boolean,
): DeleteFocusTarget[] {
  const surviving = new Set(currentCustomIds)
  const seen = new Set<string>()
  const targets: DeleteFocusTarget[] = []
  for (const id of nextSectionIds) {
    if (surviving.has(id) && !seen.has(id)) {
      seen.add(id)
      targets.push({ kind: 'section', id })
    }
  }
  if (otherIsVisible) {
    targets.push({ kind: 'other' })
  }
  for (const id of prevSectionIds) {
    if (surviving.has(id) && !seen.has(id)) {
      seen.add(id)
      targets.push({ kind: 'section', id })
    }
  }
  targets.push({ kind: 'channel-list' })
  return targets
}
