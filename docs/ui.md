# UI rules

Write shared web UI rules beyond code and tests (#200), including layout, navigation, tokens, components, states, accessibility, keyboard and copy. The maintainer chose Layout A2 (boards A2 to A2-4). This doc takes precedence if it conflicts with the [mockups](https://claude.ai/artifact/DsU9pFNvLgGfBkimjCSZm5). For sync and send, this doc covers UI presentation only. Follow the behaviour in `docs/spec/realtime.md` (C1–C10, P1–P8). Keep one home per fact and update by replacement or merge. [Writing rules](workflow.md#13-splitting-a-doc)

## 1. Layout
- Left to right (§4 tokens): **rail** (`--rail-width`: logo, navigation, presence, settings, self), rounded **チャンネル column** (`--channel-col-width`, `--navbox`), fluid rounded **main** card (minimum `--main-min-width` only at widths >= 960px), rounded **right panel** card (`--panel-width`, opens/closes).
- Separate surfaces by tone, radius and `--region-gap`, never lines.
- Each チャンネル in the column is an accordion row. Open rows show that チャンネル's recent and Unread トピック first (up to 5), then `すべてのトピック(n)›` to open the panel's トピック tab. Leave room for personal sections (#204).
- Main shows one **view** (a チャンネル's main timeline or one トピック view). Its Composer is part of that view and posts to it.
- The panel holds one **layer** (tabs トピック / 概要 / メンバー or a 返信のつながり).
- Each timeline in main or the panel has its own scroll container. The page never scrolls. Prevent text forcing width with `min-width: 0` on flex/grid children and `overflow-wrap: anywhere` in Message bodies.

## 2. Navigation: トピック and 返信のつながり
- Open a トピック view from a トピック in the チャンネル column, a トピック summary line, the panel's トピック tab or the command palette. It replaces the main timeline. Its header shows `# チャンネル ›` and a back button to the main timeline.
- A Message's `返信 n件›` or reply action opens its 返信のつながり in the right panel over the current tab. Header `‹` appears only if a tab was open and returns to it. `×` closes the panel. No deeper stack.
- URL: `/o/{organization_id}/c/{channel_id}`, optional `/t/{topic_id}` for a トピック view and `?panel=topics|overview|members|reply:{message_id}`. URLs only hint at navigation. API decides access (C9/C10). Unavailable targets show §5's state.

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
- Desktop notification click ([N6](spec/realtime.md#desktop-notifications-413-approved-not-implemented-p3)): focus the page. If `data` differs from the current Session or Organization, open nothing; else do an authorized read fenced like N6 and open the scope by the URL rules or follow C6/C9/C10. Never navigate from `data` alone.
- Every view change is announced once through the page live region (§6): `# チャンネル名` or `トピック名`.

## 3. Responsive
| Width | Rail | チャンネル column | Main | Right panel |
|---|---|---|---|---|
| >= 1280px | shown | shown | shown | pushes main narrower |
| 960-1279px | shown | shown | shown | overlays main from the right |
| 600-959px | shown | drawer from rail's チャンネル button; closes on selection or `Esc` | shown | overlays, `min(var(--panel-narrow-max), 100%)` wide |
| < 600px (phone) | bottom tab bar | its own screen | its own screen | its own full screen |

- When the right panel overlays main, use no scrim and keep main usable and scrollable.
- Phone (A2-4): one screen at a time (チャンネル list -> view -> panel layer). Header `‹` always goes up one level, replacing the entry if the previous entry is not that parent (§2). Browser/OS Back pops real history: up a level after in-app navigation, possibly out of app from a direct link. Show the bottom tab bar only at the チャンネル list level.
- At 320 CSS px, cards, dialogs and Composers fit with no horizontal scroll or clipped actions (WCAG 1.4.10). At 200% text zoom all actions remain reachable. Touch targets measure at least `--touch-target` on each axis (phone and other defaults in `web/src/app.css`).
- Drafts: one per target (Organization, チャンネル, トピック or none, reply root or none) in an Account Session memory store outside per-Organization controllers. Organization switching, navigation, resizing and level changes keep drafts. Adapters only read and forward intents (#97).
- Submit atomically moves draft text to the pending send and empties the Composer. Acknowledgements never touch drafts, so new text stays.
- Sign-out, Account Session replacement and Account switching clear all drafts. Drafts never enter web storage. Reload or browser termination loses them. `beforeunload` prompts for non-empty drafts and pending sends are best effort, especially on phones.

## 4. Design tokens
Values in `web/src/app.css` under `:root`, with dark overrides under `prefers-color-scheme: dark` and manual theme (§7). Components use tokens only. No literal colours, radii or font sizes.

| Token | Use |
|---|---|
| `--app` | page behind regions |
| `--navbox` | チャンネル column |
| `--surface` | main/panel cards and dialogs |
| `--bg` | Composer, summary lines, chips inside cards |
| `--hover` | rows and quiet buttons on hover |
| `--text` / `--text2` / `--muted` | body / secondary / meta |
| `--border` | decorative separators only |
| `--border-input` | input and control boundaries |
| `--primary` / `--on-primary` | buttons, Unread badge, selection |
| `--tint` / `--on-tint` | selected row, active tab |
| `--link` | links |
| `--focus` | focus ring |
| `--amber` / `--on-amber` | logo, @ badge, micro-interactions; never use `--amber` for text on light; use `--on-amber` on the amber fill |
| `--mention` / `--on-mention` | Message that mentions you |
| `--danger` / `--danger-bg` | errors |
| `--info-bg` / `--on-info` | connection status and notices, never amber |

- Allowed pairs in both themes: `--text`, `--text2`, `--muted` on `--app`, `--navbox`, `--surface`, `--bg`, `--hover`, `--tint`, `--mention` (lowest computed 4.52:1, light `--muted` on `--hover`). Each `--on-*` on its fill (amber pair 6.9:1). `--link`, `--primary`, `--danger` on `--surface` and `--bg`, and `--danger` on `--danger-bg`. `--border-input` and `--focus` reach 3:1 on `--surface`, `--bg` and `--app`. No inputs on `--hover`. Check any other pair the same way in its PR.
- Type: `--font-sans` (Inter for Latin and digits, then CSS fallbacks). Root size in §7, rem scale `--font-size-12` (meta), `--font-size-13`, `--font-size-14`, `--font-size-15` (body), `--font-size-17` (view title), `--font-size-20` (page title). Use `--line-height-message` for Messages. Weights: `--font-weight-regular`, `--font-weight-medium`, `--font-weight-semibold`.
- Spacing scale: `--space-4`, `--space-8`, `--space-12`, `--space-16`, `--space-24`. Radii: `--radius-8` for rows/inputs, `--radius-10` or `--radius-12` for buttons/chips/Messages, `--radius-16` for regions/Composer and `--radius-avatar` for avatars.
- Always show `--focus-ring` with `--focus-offset` on `:focus-visible` only.
- Panel slide, hover and badge pop use the `--duration-fast`, `--duration-normal`, `--duration-panel` scale and `--ease-out`. No motion under `prefers-reduced-motion: reduce`.

## 5. Components and states
Compose screens from the shared components (one per kind) in `web/src/ui/`: Button (primary, secondary, quiet, icon), Input/Textarea, Chip, Badge (Unread count, @), ListRow (チャンネル, トピック), MessageRow, ReadMarker, TopicSummaryLine, Panel (back/close header, tabs), Dialog, StatusBanner, EmptyState, Skeleton. Give one-off styles a PR reason.

- `Button` accepts optional `tabindex` (`0 | -1`) and `buttonRef` so composite widgets can exclude secondary pointer buttons from `Tab` while keeping a programmatic return-focus target.
- `MessageRow` accepts `focusable`, `rovingTabindex` (`0 | -1`), `onrowfocus`, `onrowkeydown`, `onopenreplies(opener)`. Each timeline gives exactly one confirmed row `rovingTabindex={0}` (active, otherwise latest, §9). `Tab` enters without clearing the Composer draft. Row `Enter`/`R` passes `rowRef` as opener; clicking the inline reply Button (`tabindex={-1}`) passes `buttonRef`.
- `Timeline`, `TopicView` and `ReplyPanel` share `createTimelineScrollController`, `measureTimelineItems`, `handleTimelineContainerScroll` and `applyTimelineScrollAction` from `web/src/timeline-scroll.ts` for pinned tracking, anchoring, own-send scroll to bottom and `新着 n件 ↓` (§8).
- Sender labels: see §10 for deactivated authors. Use `メンバー` for unknown authors.

Render states consistently everywhere (A2-2).

| State | Shows | Rules |
|---|---|---|
| Loading | Skeleton rows, `aria-busy="true"` | no spinner text; after 10 s still loading, show the retryable error |
| Empty | EmptyState: what is empty + what to do | Composer stays usable |
| Error, retryable | message + `再試行` | network/5xx/1011; keeps what is already shown |
| Error, not retryable | message + where to go | no retry button |
| チャンネル unavailable (C9) | `このチャンネルは利用できません` + `チャンネル一覧へ` | Disable Composer. No retry loop. Reselect to try again. The action shows the チャンネル list (desktop column, tablet drawer, full screen on phone), then focuses its visible heading (`tabindex="-1"` if needed). Never focus a hidden element |
| 組織 unavailable (C10) | `この組織は利用できません` + `メンバー資格を再確認` / `組織を切り替える`; no チャンネル retry/list action | Terminal until explicit re-selection. No automatic reconnect, resubscribe or send retry for this 組織. Keep loaded Messages and drafts visible until re-selection. Other 組織 unaffected. Say access was lost and pending Messages could not be confirmed, never that they were unsent |
| Reconnecting | StatusBanner `再接続しています…` (visual only, announcement in §6) | Keep content and send behaviour. Show banner only after 2 s offline |
| Sending | Message with `送信中…` in `--text2` | resolved by C5 |
| Send throttled | `送信が混み合っています。しばらくしてから自動で再送します。` in `--text2` + `破棄` | C6 automatic retry; no manual resend or edit; readable status text without a live role (§6) |
| Send outcome unknown | `送信を確認できませんでした。` + `再送する` / `破棄` | network error, timeout, lost ack, retryable 503: `再送する` resends with the same `client_message_id` (C6); no `編集` (a new key could duplicate a committed Message) |
| Send refused | reason + `編集して送り直す` / `破棄` | 400/403/404/409/413/415: never resent (C6); `編集して送り直す` moves the text into the Composer as a new send and removes the failed one; if that Composer already has a draft, it first asks `入力中の下書きを置き換えますか？` (`置き換える` / `キャンセル`), and `キャンセル` keeps both; offered only while that チャンネル still accepts sends |
| Send failed, target unavailable | text stays visible and selectable on the failed Message + `破棄` | C9/C10 terminal state wins over both rows above: no `再送する` or `編集して送り直す`, not hidden behind a disabled button; C6 unchanged; only that チャンネル or 組織 is affected |
| After `破棄` | the Message is removed | focus goes to the Composer |
| New Messages below | `新着 n件 ↓` button | only when not pinned (§8) |
| Sign in | board A2-3 | an ended Account Session (4001 or 401, S4 and C6) shows `ログインの有効期限が切れました。` |
| Auth operation pending | sign-in, Invite acceptance and recovery buttons disabled | one shared guard until the request and state transition finish; no queued submissions |
| Invite acceptance session 401 | error + `ログアウトして続ける` | explicit click only; waits for sign-out 204/401, then clears the error for manual resubmission; keeps the Invite and sign-in route |
| Invite sign-out failure | `ログアウトできませんでした。通信状況を確認して、もう一度お試しください。` | keeps Invite and the action; no acceptance request |

## 6. Accessibility baseline
- WCAG 2.2 AA. Use labelled `nav` elements for the rail and チャンネル column, a labelled `aside` for the panel, and `main` for main. Use one `h1` per view. Put the skip link `メッセージへ移動` first on the page.
- Use labelled lists of `article` Messages without live roles. No `role="log"`. It expects end-only additions, while older pages, gap fills, reordering and トピック summary moves change earlier rows.
- One polite `role="status"` per page is the sole live region for these events. Banners have no live role. Announce each live Message from someone else in the current view once after its 2 s window closes (`田中 美咲: 本文の先頭 80 文字`, or `新着メッセージ n件` for several in that window). The up-to-2 s delay for a single Message avoids duplicates.
- While sender lookup is pending, hold that Message and later Messages in the view until the ready prefix can enter the 2 s window. Settled omission or failure uses `メンバー`. View change or teardown drops deferred Messages.
- Also announce view changes (§2) and connection changes (after the 2 s delay). Never announce initial history, older pages, gap fills, reconnect replay, reordering, summary moves, Unread badge or read-marker changes, own sends or their confirmations. Errors needing action use `role="alert"` once.
- Full keyboard use (§9), visible focus (§4), action focus (§2, §5). After send, keep Composer focus. Enter never sends while composing (`isComposing` or `keyCode 229`).
- Icon-only buttons include the shortcut in `aria-label`, e.g. `パネルを閉じる(Esc)`.

## 7. Theme and text size
- Per-device settings in the rail's 設定 dialog. Theme: `システムに合わせる` (default, `prefers-color-scheme`), `ライト`, `ダーク`. Size: `小`, `標準` (default), `大`, `特大`. Scale root font in `web/src/app.css`: `html` for 標準, `data-text-size` values `s`, `l`, `xl` for 小, 大, 特大. Browser zoom still works.
- The sole web-storage exemption is `web/src/ui-settings.ts` (#48): `fukulow.ui.theme` (`light | dark`, absent = system) and `fukulow.ui.text-size` (`s | l | xl`, absent = standard). Validate reads and remove unknown values, using defaults. Storage errors use in-memory defaults. Test that no other key or value can be stored. The same PR must enforce the only-file storage exemption in the web-boundary check with a negative test.
- Apply in `main.ts` before mount. No inline script (CSP, #197).

## 8. Timeline scroll
- Main, Topic and Reply timelines mount viewport rows with 560px overscan. Attached rows use ResizeObserver; one persistent IntersectionObserver attaches/detaches rows for presentation. Spacer heights use measured geometry via `--row-space`; native scroll anchoring is disabled because the shared controller preserves the anchor.
- Arrow/Home/End navigate retained Message IDs and mount their destination before focus; Tab enters one mounted confirmed row. Evicted focus falls back to the Composer. A visit's Unread marker returns when its row is mounted again.
- Pinned = scrolled to within 64px of the bottom. When pinned, new Messages keep the view at the bottom; when not pinned, the position does not move and `新着 n件 ↓` appears.
- Your own send scrolls to the bottom: it is your action, not an automatic follow.
- Older pages, gap fills and reordering above the viewport keep the first visible Message at the same offset (measured anchor, not only `overflow-anchor`); focus does not move.
- Selecting another Message in the same Reply chain reveals that row. A cached target already fully in view keeps the scroll position and virtual list; an offscreen target is mounted before revealing it. The active navigation anchor remains available separately from bounded history.
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
- Every Message view and announcement retains `名前（無効）` for deactivated authors (full-width parentheses, no space). Show the whole name and state as visible, ordinary accessible text in the sender label. Never use colour alone.
- Polite plain tone (です・ます), short; no exclamation marks; no blame.
- Errors: what happened + what to do, for example `メッセージを読み込めませんでした。通信状況を確認して、もう一度お試しください。` Never show raw codes, HTTP status or English error values.
- Desktop notifications (#413): `新しいダイレクトメッセージがあります` for DMs, else `新しいメンションがあります`; no body, sender, names or count.
- Buttons are verbs: `送信`, `再試行`, `再送する`, `破棄`, `チャンネル一覧へ`.
- Unread badges use `未読 n件` as their accessible label (`Badge`); the timeline read marker uses `未読` (`ReadMarker`).
- Terms only from `docs/spec.md`; no synonyms (not スレッド for 返信のつながり, not ワークスペース for 組織).
- Channel creation: `公開範囲` groups the native radio choices `公開` (default) / `非公開`. The form uses `can_create_channels`; Guests see neither the form nor the choices. Successful creation resets the choices to `公開`; a refusal preserves the selection.
  Capability revalidation keeps an already allowed form and its input focus mounted; drafting stays usable, submission waits for current permission. A confirmed denial removes the form.
