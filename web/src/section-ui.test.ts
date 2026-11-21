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
  it('orders next section heading, Other Channels if visible, previous section heading, then Channel-list heading using current visible order', () => {
    expect(resolveDeleteFocusTargets(['s1', 's3'], 1, true)).toEqual([
      { kind: 'section', id: 's3' },
      { kind: 'other' },
      { kind: 'section', id: 's1' },
      { kind: 'channel-list' },
    ])
    expect(resolveDeleteFocusTargets(['s1'], 1, false)).toEqual([
      { kind: 'section', id: 's1' },
      { kind: 'channel-list' },
    ])
    expect(resolveDeleteFocusTargets([], 0, true)).toEqual([
      { kind: 'other' },
      { kind: 'channel-list' },
    ])
    expect(resolveDeleteFocusTargets([], 0, false)).toEqual([
      { kind: 'channel-list' },
    ])
  })
})
