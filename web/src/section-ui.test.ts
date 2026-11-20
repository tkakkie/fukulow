import { describe, expect, it } from 'vitest'
import {
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
    expect(validateSectionName('😀'.repeat(SECTION_NAME_MAX))).toBeNull()
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

describe('sectionWriteError', () => {
  it('maps every documented refusal to polite Japanese copy without raw codes or English', () => {
    const cases: Array<[Parameters<typeof sectionWriteError>[0], string]> = [
      [{ ok: false, kind: 'busy' }, '実行中'],
      [{ ok: false, kind: 'reconciling' }, '確認しています'],
      [{ ok: false, kind: 'inactive' }, '変更できません'],
      [{ ok: false, kind: 'network' }, '接続できませんでした'],
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
  it('orders next section heading, Other Channels if visible, previous section heading, then Channel-list heading', () => {
    expect(resolveDeleteFocusTargets(['s1', 's2', 's3'], 's2', true)).toEqual([
      { kind: 'section', id: 's3' },
      { kind: 'other' },
      { kind: 'section', id: 's1' },
      { kind: 'channel-list' },
    ])
    expect(resolveDeleteFocusTargets(['s1', 's2'], 's2', false)).toEqual([
      { kind: 'section', id: 's1' },
      { kind: 'channel-list' },
    ])
    expect(resolveDeleteFocusTargets(['s1'], 's1', true)).toEqual([
      { kind: 'other' },
      { kind: 'channel-list' },
    ])
    expect(resolveDeleteFocusTargets(['s1'], 's1', false)).toEqual([
      { kind: 'channel-list' },
    ])
  })
})
