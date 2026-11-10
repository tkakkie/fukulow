# UI rules

Shared rules for the web UI (#200). Layout A2, chosen by the maintainer: [mockups](https://claude.ai/artifact/DsU9pFNvLgGfBkimjCSZm5), boards A2 to A2-4. When this doc and a mockup disagree, this doc wins. Behaviour is in `docs/spec.md` (C1-C10, P1-P8); this doc only says how the UI shows it. UI text uses `docs/spec.md` Terms (チャンネル, トピック, 返信のつながり, 組織, ログイン).

## 1. Layout
- Regions, left to right: **rail** (68px: logo, navigation, presence, settings, self), **チャンネル column** (284px, a rounded `--navbox` box), **main** (rounded card, fluid, min 480px), **right panel** (360px, rounded card, opens and closes).
- Surfaces are separated by tone, radius and spacing, never by rules (lines). Gap between regions: 8px.
- チャンネル column: each チャンネル is an accordion row. When open, it shows its recent and Unread トピック first (at most 5), then `すべてのトピック(n)›`, which opens the right panel's トピック tab. Room is left for personal sections (#204).
- Main shows one **view**: a チャンネル's main timeline, or one トピック (トピック view). The Composer is part of the view and posts to it.
- Right panel holds one **layer** at a time: the tabs トピック / 概要 / メンバー, or a 返信のつながり (§2).
- Each timeline (main and panel) is its own scroll container; the page itself never scrolls. Text never forces width: `min-width: 0` on flex/grid children, `overflow-wrap: anywhere` in Message bodies.

## 2. Navigation: トピック and 返信のつながり
- Open a トピック view from: a トピック in the チャンネル column, a トピック summary line in the main timeline, the panel's トピック tab, or the command palette. It replaces the main timeline; the header shows `# チャンネル ›` and a back button to the main timeline.
- The panel's トピック tab lists the チャンネル's トピック; selecting one opens it in main. The panel stays open.
- Open a 返信のつながり from a Message's `返信 n件›` or the reply action. It opens in the right panel, over the current tab: the header has `‹` (back to the tab, shown only if a tab was open before) and `×` (close the panel). Opening another 返信のつながり replaces it (no deeper stack).
- History: a view change and opening a panel layer push one browser history entry; switching tabs replaces it. Browser Back (and `Alt+←`/`⌘[`, which the browser owns) therefore goes back one level: 返信のつながり -> tab or closed panel -> previous view.
- URL shape: `/o/{organization_id}/c/{channel_id}` plus `/t/{topic_id}` for a トピック view and `?panel=topics|overview|members|reply:{message_id}`. A URL is only a navigation hint: access is always decided by the API (C9, C10); an unavailable target shows the unavailable state (§5).
- Focus:
  - Opening a view focuses its Composer and announces `# チャンネル` or `トピック名` through the page live region (§6).
  - Opening a panel tab focuses the panel heading (`tabindex="-1"`); opening a 返信のつながり focuses its reply Composer.
  - Closing (`×`, `Esc`, Back) returns focus to the control that opened it; if it is gone, to the main Composer.
  - Back from a トピック view to the main timeline focuses that トピック's summary line if it is rendered, else the Composer.
- Wide screens (§3): the panel pushes main narrower. Narrower: the panel overlays main, with no scrim; main stays usable and scrollable.

## 3. Responsive
| Width | Rail | チャンネル column | Main | Right panel |
|---|---|---|---|---|
| >= 1280px | shown | shown | shown | pushes main |
| 960-1279px | shown | shown | shown | overlays main from the right |
| 600-959px | shown | drawer, opened from the rail's チャンネル button; closes on selection or `Esc` | shown | overlays, `min(420px, 100%)` wide |
| < 600px (phone) | becomes a bottom tab bar | its own screen | its own screen | its own full screen |
- Phone (board A2-4): one screen at a time, three levels: チャンネル list -> view -> panel layer. The header's `‹` and browser/OS Back go up one level; the bottom tab bar shows only at the チャンネル list level.
- Drafts: the controller keeps one draft per target (Organization, チャンネル, トピック or none, reply root or none) in memory for the Account Session. Navigation, resizing and changing levels keep it; a successful send clears it; sign-out, session replacement and switching Account clear all. Drafts are never written to web storage (Message text stays out of storage). Leaving the page with a non-empty draft or a pending send shows the browser's leave prompt (`beforeunload`).
- Pending and failed sends keep their text and resolve by C5 and C6; they belong to the target, not the screen.
- Touch targets at least 44 x 44px on phone, 32 x 32px elsewhere. Text zoom to 200 % keeps every action reachable (regions may stack).

## 4. Design tokens
CSS custom properties in `web/src/app.css` on `:root`, overridden for dark under `prefers-color-scheme: dark` and by the manual theme (§7). Components use tokens only: no literal colours, radii or font sizes.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--app` | `#E9EFED` | `#0A0F0E` | page behind regions |
| `--navbox` | `#F5F8F7` | `#121918` | チャンネル column box |
| `--surface` | `#FFFFFF` | `#161E1D` | main and panel cards, dialogs |
| `--bg` | `#F6F8F7` | `#0F1514` | Composer, summary lines, chips inside cards |
| `--hover` | `#DEE7E4` | `#1A2423` | hover fill |
| `--text` / `--text2` / `--muted` | `#15201E` / `#46534F` / `#5F6C68` | `#E5ECEA` / `#A8B5B1` / `#93A19D` | body / secondary / meta |
| `--border` | `#DDE5E2` | `#26312F` | decorative separators only |
| `--border-input` | `#7E8C88` | `#66736F` | input and control boundaries (3:1) |
| `--primary` / `--on-primary` | `#0B6B63` / `#FFFFFF` | `#3CC4B1` / `#04211D` | buttons, Unread badge, selection |
| `--tint` / `--on-tint` | `#DDF0EC` / `#0A5650` | `#133430` / `#9DE6D9` | selected row, active tab |
| `--link` | `#0A5E57` | `#6FD9C9` | links |
| `--focus` | `#0B6B63` | `#6FD9C9` | focus ring |
| `--amber` | `#F59E0B` | `#F5A524` | logo, @ badge, micro-interactions; never text on light |
| `--mention` / `--on-mention` | `#FFF3D6` / `#6B3F00` | `#36290C` / `#FCE3A6` | Message that mentions you |
| `--danger` / `--danger-bg` | `#B42318` / `#FDECEA` | `#F97066` / `#3A1714` | errors |
| `--info-bg` / `--on-info` | `#E6F1F8` / `#0B4A6F` | `#10283A` / `#B9DDF5` | connection status, notices (not amber) |
- Contrast (computed): every text pair above is at least 4.5:1 on its surface (lowest: `--muted` on `--app` 4.71 light); `--border-input` and `--focus` are at least 3:1. A new pair needs the same check in its PR.
- Text on `--amber` uses `#3B2300` (6.9:1).
- Type: Inter for Latin and digits, then `'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', Meiryo, sans-serif`. Sizes in `rem` from a 15px base: 12 (meta), 13, 14, 15 (body), 17 (view title), 20 (page title); line height 1.6 for Messages. Weights 400/500/600.
- Spacing: 4px steps (4, 8, 12, 16, 24). Radius: 8 (rows, inputs), 10-12 (buttons, chips, Messages), 16 (regions, Composer), 50 % (avatars).
- Focus ring: `2px solid var(--focus)`, offset 2px, on `:focus-visible` only; never removed.
- Motion: 120-200 ms ease-out for panel slide, hover and badge pop; none under `prefers-reduced-motion: reduce`.

## 5. Components and states
Shared components (one each, in `web/src/ui/`): Button (primary, secondary, quiet, icon), Input/Textarea, Chip, Badge (Unread count, @), ListRow (チャンネル, トピック), MessageRow, TopicSummaryLine, Panel (header with back/close, tabs), Dialog, StatusBanner, EmptyState, Skeleton. A screen composes these; a one-off style needs a reason in the PR.

States look the same everywhere (board A2-2):
| State | Shows | Rules |
|---|---|---|
| Loading | Skeleton rows, `aria-busy="true"` | no spinner text; after 10 s still loading, show the retryable error |
| Empty | EmptyState: what is empty + what to do | Composer stays usable |
| Error, retryable | message + `再試行` | network/5xx/1011; keeps what is already shown |
| Error, not retryable | message + where to go | no retry button |
| チャンネル unavailable (C9) | `このチャンネルは利用できません` + `チャンネル一覧へ` | Composer disabled; never retried in a loop; reselecting tries again |
| 組織 unavailable (C10) | full main state + `組織を切り替える` | terminal; states that pending sends were not sent |
| Reconnecting | StatusBanner `再接続しています…`, `role="status"` | content stays; sends queue as `送信待ち`; banner only after 2 s offline |
| Pending send | Message with `送信中…` / `送信待ち` in `--text2` | resolved by C5/C6 |
| Failed send | `送信できませんでした。` + `再送する` / `編集` / `破棄` | text kept; focus after `破棄` goes to the Composer |
| New Messages below | `新着 n件 ↓` button | only when not pinned (§8) |
| Sign in | board A2-3 | an ended Account Session (4001 or 401, S4 and C6) shows `ログインの有効期限が切れました。` |

## 6. Accessibility baseline
- WCAG 2.2 AA. Landmarks: rail and チャンネル column are `nav` with labels, main is `main`, the panel is `aside` with a label; one `h1` per view.
- Full keyboard use (§9); visible focus (§4); focus after actions as in §2 and §5; after send, focus stays in the Composer.
- One page live region (`role="status"`, polite) for view changes and connection state; errors that need action use `role="alert"`.
- IME: Enter never sends while composing (`isComposing` or `keyCode 229`).
- Icon-only buttons have `aria-label` with the shortcut, for example `パネルを閉じる(Esc)`.

## 7. Theme and text size
- Theme: `システムに合わせる` (default, `prefers-color-scheme`), `ライト`, `ダーク`. Text size: `小` 14px, `標準` 15px (default), `大` 17px, `特大` 19px, applied by scaling the root font size; browser zoom still works.
- Both are set in the 設定 dialog (rail). They are per device, not per Account.
- Persistence only through `web/src/ui-settings.ts`, the single web-storage exemption (#48): keys `fukulow.ui.theme` (`light` | `dark`; absent = system) and `fukulow.ui.text-size` (`s` | `l` | `xl`; absent = standard). Reads validate; an unknown value is removed and the default used; storage errors fall back to in-memory defaults. Tests prove no other key or value can be stored. The web-boundary check allows storage only in that file, with a negative test, in the same PR.
- Applied in `main.ts` before mounting, never by an inline script (CSP, #197).

## 8. Timeline scroll
- Pinned = scrolled to within 64px of the bottom. When pinned, new Messages keep the view at the bottom; when not pinned, the position does not move and `新着 n件 ↓` appears.
- Your own send scrolls to the bottom: it is your action, not an automatic follow.
- Older pages, gap fills and reordering above the viewport keep the first visible Message at the same offset (measured anchor, not only `overflow-anchor`); focus does not move.
- First Unread positioning and the read marker belong to #143.

## 9. Keyboard and command palette
Keyboard first: every action has a keyboard path; frequent ones have shortcuts. `⌘` on macOS is `Ctrl` elsewhere.
| Keys | Action | Where |
|---|---|---|
| `⌘K` | command palette (search and move, actions) | everywhere, also in text fields |
| `⌘/` | shortcut list | everywhere |
| `⌘.` | open or close the right panel | everywhere |
| `Alt+↑` / `Alt+↓` | previous / next チャンネル or トピック in column order | not in a text field that has text |
| `Alt+Shift+↑` / `Alt+Shift+↓` | previous / next with Unread | same |
| `F6` / `Shift+F6` | next / previous region (rail, column, main, panel) | everywhere |
| `Esc` | close the topmost layer: menu, palette or dialog, then the panel; from a Message row, back to the Composer | not while the IME is composing |
| `↑` / `↓`, `Home` / `End` | move between Messages (roving `tabindex`) | timeline |
| `Enter` or `R` | open the 返信のつながり of the focused Message | Message row |
| `↑` in an empty Composer | focus the latest Message | Composer |
| `Enter` / `Shift+Enter` | send / new line | Composer |
- Conflicts: never override browser or OS shortcuts (`⌘W/T/N/L/R/F`, `⌘[ ]`, `Alt+←/→`, `Tab`) or screen-reader keys. In text fields, text editing wins for every key without `⌘`; the IME wins while composing. Single-letter keys work only on a focused Message row.
- One keymap module is the source for handlers, the shortcut list and the hints shown in the palette and labels. No remapping for now.
- Palette (board A2-1, Tweaks): a modal `dialog`; input is a `combobox` with a `listbox` and `aria-activedescendant`; results grouped as チャンネル, トピック (from lists already loaded; server Search is separate) and 操作, each with its shortcut. Focus is trapped; `Esc` closes and restores focus to the invoker; a move command applies the destination focus rule (§2).
- Individual commands beyond moving, panel and shortcut list come in follow-up Issues.

## 10. Japanese copy
- Polite plain tone (です・ます), short; no exclamation marks; no blame.
- Errors: what happened + what to do, for example `メッセージを読み込めませんでした。通信状況を確認して、もう一度お試しください。` Never show raw codes, HTTP status or English error values.
- Buttons are verbs: `送信`, `再試行`, `再送する`, `破棄`, `チャンネル一覧へ`.
- Terms only from `docs/spec.md`; no synonyms (not スレッド for 返信のつながり, not ワークスペース for 組織).
