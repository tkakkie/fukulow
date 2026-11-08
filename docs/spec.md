# Spec

## Terms (English in code/API, Japanese in UI)
Organization/組織, Member/メンバー, Role (Owner/オーナー, Admin/管理者, Member/メンバー, Guest/ゲスト), Invite/招待,
Channel/チャンネル (public/private), Topic/トピック, Message/メッセージ, Reply/返信, Reply chain/返信のつながり,
Move to topic/トピックに移動, Direct message (DM)/ダイレクトメッセージ, Mention/メンション, Unread/未読,
Reaction/リアクション, Attachment/添付ファイル, Search/検索, Notification/通知, Edit/編集, Delete/削除,
Archive/アーカイブ, Sign in/ログイン, Settings/設定.

## Model
- A channel's timeline shows messages that have no topic (topic = null).
- Reply: a message may reply to another message. Replies form a chain, shown together in a right-side panel.
- A reply chain can be moved to a topic under the channel. A topic can also be created first and posted to directly.
- Messages inside a topic are shown only in the topic. The main timeline shows one line when a topic is created/updated.
- No threads. No calls (use external OSS if ever needed).

## MVP
Sign in, organization, channels, topics, reply chains, DM, unread/mention, basic search.
Later: attachments, reactions, push notifications, bots/webhooks, multiple organizations UI, OIDC.

## Performance targets (first)
One node: 10k concurrent connections, thousands of message writes/s. Measure with load tests before optimizing.
