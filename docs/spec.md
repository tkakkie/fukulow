# Spec

## Terms (English in code/API, Japanese in UI)
Account/アカウント, Organization/組織, Member/メンバー, Role (Owner/オーナー, Admin/管理者, Member/メンバー, Guest/ゲスト), Invite/招待,
Channel/チャンネル (public/private), Channel manager/チャンネル管理者, Topic/トピック, Message/メッセージ, Reply/返信, Reply chain/返信のつながり,
Move to topic/トピックに移動, Direct message (DM)/ダイレクトメッセージ, Mention/メンション, Unread/未読,
Reaction/リアクション, Attachment/添付ファイル, Search/検索, Notification/通知, Edit/編集, Delete/削除,
Archive/アーカイブ, Sign in/ログイン, Settings/設定.

## Model
- A channel's timeline shows messages that have no topic (topic = null).
- Reply: a message may reply to another message. Replies form a chain, shown together in a right-side panel.
- A reply chain can be moved to a topic under the channel. A topic is created by its first message (or by a Move to a new topic); empty topics do not exist.
- Messages inside a topic are shown only in the topic. The main timeline shows one summary line per topic, at the topic's latest activity (a derived display).
- No threads. No calls (use external OSS if ever needed).

## MVP
Sign in, organization, channels, topics, reply chains, DM, unread/mention, basic search.
Later: attachments, reactions, push notifications, bots/webhooks, multiple organizations UI, OIDC.

## Parts
- [Accounts](spec/accounts.md): Accounts and Memberships; Members, Roles and Invites; Setup.
- [Deployment](spec/deployment.md): Proxy and sign-in limits; Database deployment and upgrade (#194 B); Deployment (#194 C); HTTP availability; Operations: backup and restore (#198 C).
- [Realtime](spec/realtime.md): Real-time sync contract.

## Performance targets (first)
One node: 10k concurrent connections, thousands of message writes/s. Measure with load tests before optimizing.
