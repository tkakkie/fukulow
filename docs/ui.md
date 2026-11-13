# UI rules

Writing: short shared UI rules (layout, navigation, tokens, components, states, accessibility, keyboard, copy); it wins over mockups.

Shared rules for the web UI (#200). Layout A2, chosen by the maintainer: [mockups](https://claude.ai/artifact/DsU9pFNvLgGfBkimjCSZm5), boards A2 to A2-4. When this doc and a mockup disagree, this doc wins. Behaviour is in `docs/spec/realtime.md` (C1-C10, P1-P8); this doc only says how the UI shows it and changes no sync or send policy. UI text uses `docs/spec.md` Terms (チャンネル, トピック, 返信のつながり, 組織, ログイン).

## 1. Layout
- Regions, left to right: **rail** (68px: logo, navigation, presence, settings, self), **チャンネル column** (284px, a rounded `--navbox` box), **main** (rounded card, fluid; at least 480px only at widths >= 960px), **right panel** (360px, rounded card, opens and closes).
- Surfaces are separated by tone, radius and spacing, never by rules (lines). Gap between regions: 8px.
- チャンネル column: each チャンネル is an accordion row. When open, it shows its recent and Unread トピック first (at most 5), then `すべてのトピック(n)›`, which opens the right panel's トピック tab. Room is left for personal sections (#204).
- Main shows one **view**: a チャンネル's main timeline, or one トピック (トピック view). The Composer is part of the view and posts to it.
- Right panel holds one **layer** at a time: the tabs トピック / 概要 / メンバー, or a 返信のつながり.
- Each timeline (main and panel) is its own scroll container; the page itself never scrolls. Text never forces width: `min-width: 0` on flex/grid children, `overflow-wrap: anywhere` in Message bodies.

## 2. Navigation: トピック and 返信のつながり
- A トピック view opens from a トピック in the チャンネル column, a トピック summary line, the panel's トピック tab or the command palette, and replaces the main timeline. Its header shows `# チャンネル ›` and a back button to the main timeline.
- A 返信のつながり opens from a Message's `返信 n件›` or the reply action, in the right panel over the current tab. Header: `‹` (back to the tab, only if a tab was open before) and `×` (close the panel). There is no deeper stack.
- URL: `/o/{organization_id}/c/{channel_id}`, plus `/t/{topic_id}` for a トピック view and `?panel=topics|overview|members|reply:{message_id}`. A URL is only a navigation hint: the API decides access (C9, C10); an unavailable target shows its unavailable state (§5).

| Action | History | Main | Panel | Focus |
|---|---|---|---|---|
| Select a チャンネル (column, palette, `Alt+↓`) | push | its main timeline | a tab stays open, re-scoped; a 返信のつながり closes | Composer |
| Open a トピック view (any source) | push | that トピック | unchanged; phone: the panel layer is dropped | Composer |
| Back button in a トピック view | replace with this チャンネル's timeline URL, keeping `panel` | main timeline | unchanged | that トピック's summary line if rendered, else Composer |
| Open a tab (header button, `⌘.`) | push | unchanged | tab | panel heading (`tabindex="-1"`) |
| Switch tab | replace | unchanged | other tab | the tab |
| Open a 返信のつながり | push; replace if one is already open | unchanged | 返信のつながり | its reply Composer |
| `‹` in a 返信のつながり | replace with the current main URL plus the previous tab | unchanged | the tab | the tab |
| `×`, `Esc` | replace with the current main URL without `panel` (never pops, so main cannot change); older entries stay, so Browser Back may reopen a panel | unchanged | closed | the control that opened the panel; if gone, the main Composer |
| Browser/OS Back | the browser pops | from the URL | from the URL | as for the matching row above |
| Direct link or reload | one entry, no synthetic parents | from the URL | from the URL | Composer; in-app `‹` replaces with the parent level (panel -> view -> チャンネル list), so it never leaves the app |
- Every view change is announced once through the page live region (§6): `# チャンネル名` or `トピック名`.
- Wide screens (§3): the panel pushes main narrower. Narrower: the panel overlays main, with no scrim; main stays usable and scrollable.

## 3. Responsive
| Width | Rail | チャンネル column | Main | Right panel |
|---|---|---|---|---|
| >= 1280px | shown | shown | shown | pushes main |
| 960-1279px | shown | shown | shown | overlays main from the right |
| 600-959px | shown | drawer, opened from the rail's チャンネル button; closes on selection or `Esc` | shown | overlays, `min(420px, 100%)` wide |
| < 600px (phone) | becomes a bottom tab bar | its own screen | its own screen | its own full screen |
- Phone (board A2-4): one screen at a time, three levels: チャンネル list -> view -> panel layer. The header's `‹` always goes up one level and replaces the entry when the previous entry is not that parent (§2 table). Browser/OS Back pops real history: after in-app navigation that is one level up, but from a direct link it may leave the app; the bottom tab bar shows only at the チャンネル list level.
- Reflow: at 320 CSS px wide, cards, dialogs and Composers fit without horizontal scrolling or clipped actions (WCAG 1.4.10); text zoom to 200 % keeps every action reachable.
- Touch targets at least 44 x 44px on phone, 32 x 32px elsewhere.
- Drafts:
  - One draft per target (Organization, チャンネル, トピック or none, reply root or none), held in memory by a store owned by the Account Session, outside the per-Organization controllers, so switching Organization keeps it. Adapters only read it and forward intents (#97).
  - Navigation, resizing and changing levels keep it. Submitting moves that text into the pending send and empties the Composer in one step; an acknowledgement never touches the draft, so text typed meanwhile stays.
  - Sign-out, session replacement and switching Account drop all drafts. Drafts are never written to web storage.
  - Reload or browser termination loses drafts. A `beforeunload` prompt for non-empty drafts and pending sends is best effort (browsers, especially on phones, may skip it).

## 4. Design tokens
CSS custom properties in `web/src/app.css` on `:root`, overridden for dark under `prefers-color-scheme: dark` and by the manual theme (§7). Components use tokens only: no literal colours, radii or font sizes.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--app` | `#E9EFED` | `#0A0F0E` | page behind regions |
| `--navbox` | `#F5F8F7` | `#121918` | チャンネル column box |
| `--surface` | `#FFFFFF` | `#161E1D` | main and panel cards, dialogs |
| `--bg` | `#F6F8F7` | `#0F1514` | Composer, summary lines, chips inside cards |
| `--hover` | `#E3EBE8` | `#1A2423` | hover fill of rows and quiet buttons |
| `--text` / `--text2` / `--muted` | `#15201E` / `#46534F` / `#5F6C68` | `#E5ECEA` / `#A8B5B1` / `#93A19D` | body / secondary / meta |
| `--border` | `#DDE5E2` | `#26312F` | decorative separators only |
| `--border-input` | `#7E8C88` | `#66736F` | input and control boundaries |
| `--primary` / `--on-primary` | `#0B6B63` / `#FFFFFF` | `#3CC4B1` / `#04211D` | buttons, Unread badge, selection |
| `--tint` / `--on-tint` | `#DDF0EC` / `#0A5650` | `#133430` / `#9DE6D9` | selected row, active tab |
| `--link` | `#0A5E57` | `#6FD9C9` | links |
| `--focus` | `#0B6B63` | `#6FD9C9` | focus ring |
| `--amber` | `#F59E0B` | `#F5A524` | logo, @ badge, micro-interactions; never text on light |
| `--mention` / `--on-mention` | `#FFF3D6` / `#6B3F00` | `#36290C` / `#FCE3A6` | Message that mentions you |
| `--danger` / `--danger-bg` | `#B42318` / `#FDECEA` | `#F97066` / `#3A1714` | errors |
| `--info-bg` / `--on-info` | `#E6F1F8` / `#0B4A6F` | `#10283A` / `#B9DDF5` | connection status, notices (not amber) |
- Allowed pairs (computed, both themes): `--text`, `--text2` and `--muted` on `--app`, `--navbox`, `--surface`, `--bg`, `--hover`, `--tint` and `--mention` (lowest 4.52:1, `--muted` on `--hover` light); each `--on-*` on its own fill; `--link`, `--primary` and `--danger` on `--surface` and `--bg`; `--danger` on `--danger-bg`. Text on `--amber` uses `#3B2300` (6.9:1). `--border-input` and `--focus` reach 3:1 on `--surface`, `--bg` and `--app`; inputs never sit on `--hover`. Any other pair needs the same check in its PR.
- Type: Inter for Latin and digits, then `'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', Meiryo, sans-serif`. Sizes in `rem` from a 15px base: 12 (meta), 13, 14, 15 (body), 17 (view title), 20 (page title); line height 1.6 for Messages. Weights 400/500/600.
- Spacing: 4px steps (4, 8, 12, 16, 24). Radius: 8 (rows, inputs), 10-12 (buttons, chips, Messages), 16 (regions, Composer), 50 % (avatars).
- Focus ring: `2px solid var(--focus)`, offset 2px, on `:focus-visible` only; never removed.
- Motion: 120-200 ms ease-out for panel slide, hover and badge pop; none under `prefers-reduced-motion: reduce`.

## 5. Components and states
Shared components (one each, in `web/src/ui/`): Button (primary, secondary, quiet, icon), Input/Textarea, Chip, Badge (Unread count, @), ListRow (チャンネル, トピック), MessageRow, ReadMarker, TopicSummaryLine, Panel (header with back/close, tabs), Dialog, StatusBanner, EmptyState, Skeleton. A screen composes these; a one-off style needs a reason in the PR.
- Focus and keyboard contracts: `Button` accepts optional `tabindex` (`0 | -1`) and `buttonRef` so composite widgets can omit secondary pointer buttons from the `Tab` sequence while keeping a programmatic return-focus target. `MessageRow` takes `focusable`, `rovingTabindex` (`0 | -1`), `onrowfocus`, `onrowkeydown` and `onopenreplies(opener)`; each timeline assigns `rovingTabindex={0}` to exactly one confirmed row (the active row, or the latest row by default, §9) so `Tab` enters the timeline without clearing a Composer draft, `Enter`/`R` on the row passes `rowRef` as `opener`, and clicking the inline reply `Button` (`tabindex={-1}`) passes `buttonRef` as `opener`.
- Shared timeline scroll (`web/src/timeline-scroll.ts`): `Timeline`, `TopicView` and `ReplyPanel` share `createTimelineScrollController`, `measureTimelineItems`, `handleTimelineContainerScroll` and `applyTimelineScrollAction` for pinned tracking, anchor preservation, own-send scroll-to-bottom and `新着 n件 ↓` (§8).
- Deactivated Message authors keep their name followed by the visible text `（無効）`. The whole `名前（無効）` is ordinary accessible text in the sender label, so screen readers convey both name and state; colour alone never carries the hint. Unknown authors show `メンバー`.

States look the same everywhere (board A2-2):
| State | Shows | Rules |
|---|---|---|
| Loading | Skeleton rows, `aria-busy="true"` | no spinner text; after 10 s still loading, show the retryable error |
| Empty | EmptyState: what is empty + what to do | Composer stays usable |
| Error, retryable | message + `再試行` | network/5xx/1011; keeps what is already shown |
| Error, not retryable | message + where to go | no retry button |
| チャンネル unavailable (C9) | `このチャンネルは利用できません` + `チャンネル一覧へ` | Composer disabled; never retried in a loop; reselecting tries again. `チャンネル一覧へ` shows the チャンネル list (desktop column, tablet drawer, phone full screen) and, once it is shown, focuses the list heading (`tabindex="-1"` if needed); never a hidden element |
| 組織 unavailable (C10) | `この組織は利用できません` + `メンバー資格を再確認` / `組織を切り替える` (no チャンネル retry/list action) | terminal until explicit re-selection: no automatic reconnect, resubscribe or send retry for that 組織; loaded Messages and drafts stay visible until re-selection; other 組織 unaffected. Copy says access was lost and pending Messages could not be confirmed, never that they were not sent |
| Reconnecting | StatusBanner `再接続しています…` (visual only, no live role; the page status region announces it, §6) | content stays; banner only after 2 s offline; send behaviour unchanged (presentation only) |
| Sending | Message with `送信中…` in `--text2` | resolved by C5 |
| Send outcome unknown | `送信を確認できませんでした。` + `再送する` / `破棄` | network error, timeout, lost ack, retryable 503: `再送する` resends with the same `client_message_id` (C6); no `編集` (a new key could duplicate a committed Message) |
| Send refused | reason + `編集して送り直す` / `破棄` | 400/403/404/409/413/415: never resent (C6); `編集して送り直す` moves the text into the Composer as a new send and removes the failed one; if that Composer already has a draft, it first asks `入力中の下書きを置き換えますか？` (`置き換える` / `キャンセル`), and `キャンセル` keeps both; offered only while that チャンネル still accepts sends |
| Send failed, target unavailable | text stays visible and selectable on the failed Message + `破棄` | C9/C10 terminal state wins over both rows above: no `再送する` or `編集して送り直す`, not hidden behind a disabled button; C6 unchanged; only that チャンネル or 組織 is affected |
| After `破棄` | the Message is removed | focus goes to the Composer |
| New Messages below | `新着 n件 ↓` button | only when not pinned (§8) |
| Sign in | board A2-3 | an ended Account Session (4001 or 401, S4 and C6) shows `ログインの有効期限が切れました。` |

## 6. Accessibility baseline
- WCAG 2.2 AA. Landmarks: rail and チャンネル column are `nav` with labels, main is `main`, the panel is `aside` with a label; one `h1` per view; a skip link `メッセージへ移動` first in the page.
- Timeline semantics: the timeline is a labelled list of `article` Messages without live-region roles; it is not `role="log"`, because older pages, gap fills, reordering and トピック summary moves change it outside the end, where ARIA `log` expects additions only.
- Announcements: one polite `role="status"` region per page, the only live region for these events (banners such as StatusBanner have no live role). It announces each Message received live from someone else in the current view once (`田中 美咲: 本文の先頭 80 文字`; several within 2 s become `新着メッセージ n件`). Each announcement waits for its 2 s window to close, so a single Message is announced up to 2 s late; this delay is accepted to avoid duplicate announcements, view changes (§2) and connection changes (after the 2 s delay). It never announces initial history, older pages, gap fills, replay after reconnect, reordering, summary-line moves, Unread badge or read-marker changes, own sends or their confirmations. Errors that need action use `role="alert"` once.
- Full keyboard use (§9); visible focus (§4); focus after actions as in §2 and §5; after send, focus stays in the Composer.
- IME: Enter never sends while composing (`isComposing` or `keyCode 229`).
- Icon-only buttons have an `aria-label` that includes the shortcut, for example `パネルを閉じる(Esc)`.

## 7. Theme and text size
- Theme: `システムに合わせる` (default, `prefers-color-scheme`), `ライト`, `ダーク`. Text size: `小` 14px, `標準` 15px (default), `大` 17px, `特大` 19px, applied by scaling the root font size; browser zoom still works.
- Both are set in the 設定 dialog (rail). They are per device, not per Account.
- Persistence only through `web/src/ui-settings.ts`, the single web-storage exemption (#48): keys `fukulow.ui.theme` (`light` | `dark`; absent = system) and `fukulow.ui.text-size` (`s` | `l` | `xl`; absent = standard). Reads validate; an unknown value is removed and the default used; storage errors fall back to in-memory defaults. Tests prove no other key or value can be stored. The web-boundary check allows storage only in that file, with a negative test, in the same PR.
- Applied in `main.ts` before mounting, never by an inline script (CSP, #197).

## 8. Timeline scroll
- Pinned = scrolled to within 64px of the bottom. When pinned, new Messages keep the view at the bottom; when not pinned, the position does not move and `新着 n件 ↓` appears.
- Your own send scrolls to the bottom: it is your action, not an automatic follow.
- Older pages, gap fills and reordering above the viewport keep the first visible Message at the same offset (measured anchor, not only `overflow-anchor`); focus does not move.
- On entering the main timeline or a トピック view, the entry boundary is that scope's read position at entry. If an other-sender Message exists above the boundary, older projection pages load until that first Unread Message is in the window, the view opens positioned at it, and `ReadMarker` (`未読`) is shown above it for the whole visit while the read position advances. With no Unread, the view opens pinned at the bottom with no marker.
- A confirmed Message of the active scope is marked presented when its row is inside the timeline viewport while that view is selected and `document.visibilityState === 'visible'`. Hidden tabs, main-timeline `TopicSummaryLine` rows and `ReplyPanel` never advance read positions.

## 9. Keyboard and command palette
Keyboard first: every action has a keyboard path; frequent ones have shortcuts and a visible control. `⌘` on macOS is `Ctrl` elsewhere.
| Keys | Action | Where |
|---|---|---|
| `⌘K` | command palette (search and move, actions); also the rail's 検索 button | everywhere, also in text fields |
| `⌘/` | shortcut list | everywhere |
| `⌘.` | open or close the right panel; also the header buttons | everywhere |
| `Alt+↑` / `Alt+↓` | previous / next チャンネル or トピック in column order | not in a text field that has text |
| `Alt+Shift+↑` / `Alt+Shift+↓` | previous / next with Unread | same |
| `Esc` | close the topmost layer: menu, palette or dialog, then the panel; from a Message row, back to the Composer | not while the IME is composing |
| `↑` / `↓`, `Home` / `End` | move between Messages (roving `tabindex`) | a focused Message row |
| `Enter` or `R` | open the 返信のつながり of the focused Message | a focused Message row |
| `↑` | focus the latest Message | an empty Composer, no IME |
| `Enter` / `Shift+Enter` | send / new line | Composer |
- Conflicts: browser, OS and screen-reader shortcuts are not overridden (`⌘W/T/N/L/R/F`, `⌘[ ]`, `Alt+←/→`, `Tab`, `F6`). One deliberate exception: `Ctrl+K`/`⌘K`, which Chrome on Windows uses for address-bar search; a chat convention, always paired with the visible 検索 button. Regions are reached by landmarks and the skip link, not by a shortcut.
- Matching: exact modifiers only; ignore events with `defaultPrevented`; the IME wins while composing (`isComposing`, `keyCode 229`); in text fields text editing wins for every key without `⌘`, except `↑` in an empty Composer. Row keys act only when the row itself is the event target, never a control inside it.
- One keymap module is the source for handlers, the shortcut list and the hints shown in the palette and labels. No remapping for now.
- Palette (board A2-1, Tweaks): a modal `dialog`; input is a `combobox` with a `listbox` and `aria-activedescendant`; results grouped as チャンネル, トピック (from lists already loaded; server Search is separate) and 操作, each with its shortcut. Focus is trapped; `Esc` closes and restores focus to the invoker; a move command applies the destination focus rule (§2).
- Individual commands beyond moving, panel and shortcut list come in follow-up Issues.

## 10. Japanese copy
- Deactivated author: `名前（無効）` (full-width parentheses, no space); retain the name and hint together in every Message view and announcement.
- Polite plain tone (です・ます), short; no exclamation marks; no blame.
- Errors: what happened + what to do, for example `メッセージを読み込めませんでした。通信状況を確認して、もう一度お試しください。` Never show raw codes, HTTP status or English error values.
- Buttons are verbs: `送信`, `再試行`, `再送する`, `破棄`, `チャンネル一覧へ`.
- Unread badges use `未読 n件` as their accessible label (`Badge`); the timeline read marker uses `未読` (`ReadMarker`).
- Terms only from `docs/spec.md`; no synonyms (not スレッド for 返信のつながり, not ワークスペース for 組織).
