import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildMoveDestinations,
  IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL,
  OTHER_CHANNELS_LABEL,
  reorderList,
  resolveDeleteFocusTargets,
  SECTION_NAME_MAX,
  sectionWriteError,
  validateSectionName,
} from './section-ui'

describe('validateSectionName', () => {
  it('accepts 1..=60 Unicode scalars including multi-code-unit emoji and internal whitespace', () => {
    expect(validateSectionName('開発')).toBeNull()
    expect(validateSectionName('開発 チーム')).toBeNull()
    expect(validateSectionName('開発\u0085チーム')).toBeNull()
    expect(validateSectionName('😀'.repeat(SECTION_NAME_MAX))).toBeNull()
  })

  it('matches Rust str::trim() whitespace: accepts edge U+FEFF and rejects edge or standalone U+0085', () => {
    // U+FEFF is not Unicode White_Space, so Rust str::trim() preserves it.
    expect(validateSectionName('\uFEFF開発')).toBeNull()
    expect(validateSectionName('開発\uFEFF')).toBeNull()
    expect(validateSectionName('\uFEFF')).toBeNull()
    // U+0085 (NEL) is Unicode White_Space, so Rust str::trim() strips it.
    expect(validateSectionName('\u0085')).toBe('セクション名を入力してください。')
    expect(validateSectionName('\u0085開発')).toContain('前後に空白')
    expect(validateSectionName('開発\u0085')).toContain('前後に空白')
  })

  it('rejects empty, whitespace-only, surrounding whitespace, NUL and >60 scalars', () => {
    expect(validateSectionName('')).toBe('セクション名を入力してください。')
    expect(validateSectionName('   ')).toBe('セクション名を入力してください。')
    expect(validateSectionName(' 開発')).toContain('前後に空白')
    expect(validateSectionName('開発 ')).toContain('前後に空白')
    expect(validateSectionName('開発\0チーム')).toContain('使用できない文字')
    expect(validateSectionName('😀'.repeat(SECTION_NAME_MAX + 1))).toContain('60文字以内')
  })
})

describe('buildMoveDestinations', () => {
  it('identifies the implicit group and disambiguates duplicate names including その他のチャンネル', () => {
    expect(buildMoveDestinations([
      { id: 's1', name: '開発' },
      { id: 's2', name: '運用' },
    ])).toEqual([
      { id: 's1', label: '開発' },
      { id: 's2', label: '運用' },
      { id: null, label: IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL },
    ])

    const duplicateOptions = buildMoveDestinations([
      { id: 's1', name: '開発' },
      { id: 's2', name: OTHER_CHANNELS_LABEL },
      { id: 's3', name: '開発' },
      { id: 's4', name: OTHER_CHANNELS_LABEL },
    ])
    expect(duplicateOptions).toEqual([
      { id: 's1', label: '開発（1番目）' },
      { id: 's2', label: `${OTHER_CHANNELS_LABEL}（1番目）` },
      { id: 's3', label: '開発（2番目）' },
      { id: 's4', label: `${OTHER_CHANNELS_LABEL}（2番目）` },
      { id: null, label: IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL },
    ])
    // Every visible/accessible label is unique.
    expect(new Set(duplicateOptions.map(o => o.label)).size).toBe(duplicateOptions.length)
  })

  it('guarantees unique labels even when raw names collide with generated disambiguation suffixes', () => {
    const reviewCase = buildMoveDestinations([
      { id: 's1', name: '開発（1番目）' },
      { id: 's2', name: '開発（3番目のセクション）' },
      { id: 's3', name: '開発' },
      { id: 's4', name: '開発' },
    ])
    expect(reviewCase.map(o => o.id)).toEqual(['s1', 's2', 's3', 's4', null])
    expect(new Set(reviewCase.map(o => o.label)).size).toBe(reviewCase.length)
    expect(reviewCase[0]!.label).toBe('開発（1番目）')
    expect(reviewCase[1]!.label).toBe('開発（3番目のセクション）')
    expect(reviewCase[4]!.label).toBe(IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL)

    // Also handles a raw name appearing later in the list that matches an early generated suffix,
    // and a custom section literally named like the implicit destination label.
    const reverseAndImplicitCase = buildMoveDestinations([
      { id: 'a1', name: '開発' },
      { id: 'a2', name: '開発' },
      { id: 'a3', name: '開発（1番目）' },
      { id: 'a4', name: IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL },
    ])
    expect(new Set(reverseAndImplicitCase.map(o => o.label)).size).toBe(reverseAndImplicitCase.length)
    expect(reverseAndImplicitCase[2]!.label).toBe('開発（1番目）')
    expect(reverseAndImplicitCase[4]!.label).toBe(IMPLICIT_OTHER_CHANNELS_DESTINATION_LABEL)
  })
})

describe('sectionWriteError', () => {
  it('maps every documented refusal to polite Japanese copy without raw codes or English', () => {
    const cases: Array<[Parameters<typeof sectionWriteError>[0], string]> = [
      [{ ok: false, kind: 'busy' }, '実行中'],
      [{ ok: false, kind: 'reconciling' }, '確認しています'],
      [{ ok: false, kind: 'inactive' }, '変更できません'],
      [{ ok: false, kind: 'network' }, '更新を確認できませんでした'],
      [{ ok: false, kind: 'network', error: 'lock_contention' }, '他の更新と重なった'],
      [{ ok: false, kind: 'http', status: 503, error: 'lock_contention' }, '他の更新と重なった'],
      [{ ok: false, kind: 'http', status: 401, error: 'invalid credentials' }, '有効期限'],
      [{ ok: false, kind: 'http', status: 404, error: 'organization_unavailable' }, 'この組織は利用できません'],
      [{ ok: false, kind: 'http', status: 400, error: 'invalid_section_name' }, '60文字以内'],
      [{ ok: false, kind: 'http', status: 400, error: 'invalid_section_order' }, '並び替え'],
      [{ ok: false, kind: 'http', status: 404, error: 'section_not_found' }, '見つかりませんでした'],
      [{ ok: false, kind: 'http', status: 404, error: 'channel not found' }, 'このチャンネルは利用できません'],
      [{ ok: false, kind: 'http', status: 409, error: 'channel_archived' }, 'アーカイブ済み'],
      [{ ok: false, kind: 'http', status: 409, error: 'section_limit' }, '50件'],
      [{ ok: false, kind: 'http', status: 409, error: 'section_deleted' }, 'すでに削除'],
      [{ ok: false, kind: 'http', status: 409, error: 'section_id_conflict' }, '同じ識別子'],
      [{ ok: false, kind: 'http', status: 409, error: 'section_layout_changed' }, '別の操作でセクション一覧が更新'],
      [{ ok: false, kind: 'http', status: 500, error: 'internal error' }, '更新できませんでした'],
    ]
    for (const [result, expectedFragment] of cases) {
      const msg = sectionWriteError(result)
      expect(msg).toContain(expectedFragment)
      expect(msg).not.toMatch(/[a-zA-Z_]/)
      expect(msg).not.toMatch(/\b[45]\d\d\b/)
      expect(msg).not.toContain('!')
      expect(msg).not.toContain('！')
    }
  })
})

describe('reorderList', () => {
  it('moves items one step up or down and returns null at boundaries', () => {
    expect(reorderList(['a', 'b', 'c'], 1, 'up')).toEqual(['b', 'a', 'c'])
    expect(reorderList(['a', 'b', 'c'], 1, 'down')).toEqual(['a', 'c', 'b'])
    expect(reorderList(['a', 'b', 'c'], 0, 'up')).toBeNull()
    expect(reorderList(['a', 'b', 'c'], 2, 'down')).toBeNull()
  })
})

describe('resolveDeleteFocusTargets', () => {
  it('resolves the first surviving next neighbor, Other Channels if visible, previous neighbor, then Channel-list heading', () => {
    // [A, B, C, D]: B deleted here (next=[C, D], prev=[A]) and A deleted elsewhere -> focus C, not D.
    expect(resolveDeleteFocusTargets(['C', 'D'], ['C', 'D'], ['A'], true)).toEqual([
      { kind: 'section', id: 'C' },
      { kind: 'section', id: 'D' },
      { kind: 'other' },
      { kind: 'channel-list' },
    ])
    // Next neighbor C also deleted -> falls through to surviving next D.
    expect(resolveDeleteFocusTargets(['A', 'D'], ['C', 'D'], ['A'], false)).toEqual([
      { kind: 'section', id: 'D' },
      { kind: 'section', id: 'A' },
      { kind: 'channel-list' },
    ])
    // All next neighbors gone and Other Channels hidden -> first surviving previous neighbor.
    expect(resolveDeleteFocusTargets(['A'], ['C', 'D'], ['A'], false)).toEqual([
      { kind: 'section', id: 'A' },
      { kind: 'channel-list' },
    ])
    expect(resolveDeleteFocusTargets([], [], [], true)).toEqual([
      { kind: 'other' },
      { kind: 'channel-list' },
    ])
    expect(resolveDeleteFocusTargets([], [], [], false)).toEqual([
      { kind: 'channel-list' },
    ])
  })
})

describe('Dialog scroll body focus outline clearance', () => {
  it('insets .ui-dialog__body by at least the 4px focus outline + offset so full-width controls are not clipped', () => {
    const dialogSrc = readFileSync(resolve(import.meta.dirname, 'ui/Dialog.svelte'), 'utf8')
    const bodyRule = dialogSrc.match(/\.ui-dialog__body\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(bodyRule).toContain('overflow-y: auto;')
    expect(bodyRule).toContain('padding: var(--space-4);')
    expect(bodyRule).toContain('margin: calc(-1 * var(--space-4));')
  })
})
