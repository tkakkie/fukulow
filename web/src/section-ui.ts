import type { SectionResult } from './sections'

/** Max section name length in Unicode scalar values (spec R1). */
export const SECTION_NAME_MAX = 60

export const OTHER_CHANNELS_LABEL = 'その他のチャンネル'
export const IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL = `${OTHER_CHANNELS_LABEL}（既定）`

// Rust `str::trim()` strips Unicode `White_Space` (`char::is_whitespace`), which includes U+0085 (NEL)
// and excludes U+FEFF (BOM), unlike JS `String.prototype.trim()`.
const RUST_WHITESPACE_ONLY = /^\p{White_Space}+$/u
const RUST_SURROUNDING_WHITESPACE = /^\p{White_Space}|\p{White_Space}$/u

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
  const counts = new Map<string, number>([
    [OTHER_CHANNELS_LABEL, 1],
    [IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL, 1],
  ])
  for (const s of customSections) {
    counts.set(s.name, (counts.get(s.name) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const used = new Set<string>([IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL])
  const options: MoveDestinationOption[] = customSections.map((s, idx) => {
    let label = s.name
    if ((counts.get(s.name) ?? 0) > 1 || used.has(label)) {
      const occ = (seen.get(s.name) ?? 0) + 1
      seen.set(s.name, occ)
      label = `${s.name}（${occ}番目）`
      if (used.has(label)) {
        label = `${s.name}（${idx + 1}番目のセクション）`
      }
    }
    used.add(label)
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
  if (result.status === 401) {
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
 * Computes the ordered focus fallback targets after a section at `deletedIndex` is removed,
 * using the current visible custom-section order after reconciliation (`docs/spec/sections.md`):
 * next section heading (including Other Channels when visible), then previous section heading,
 * then the Channel-list heading.
 */
export function resolveDeleteFocusTargets(
  currentCustomIds: readonly string[],
  deletedIndex: number,
  otherIsVisible: boolean,
): DeleteFocusTarget[] {
  const split = Math.max(0, Math.min(deletedIndex, currentCustomIds.length))
  const targets: DeleteFocusTarget[] = []
  for (let i = split; i < currentCustomIds.length; i++) {
    targets.push({ kind: 'section', id: currentCustomIds[i] })
  }
  if (otherIsVisible) {
    targets.push({ kind: 'other' })
  }
  for (let i = split - 1; i >= 0; i--) {
    targets.push({ kind: 'section', id: currentCustomIds[i] })
  }
  targets.push({ kind: 'channel-list' })
  return targets
}
