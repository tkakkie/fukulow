import { isSessionEnded, type Result } from './api'
import { sessionEndedMessage } from './auth'

export function memberError(r: Exclude<Result<unknown>, { ok: true }>): string {
  if (r.kind === 'network') return 'サーバーに接続できません。もう一度お試しください。'
  if (r.error === 'last_owner') return '最後のオーナーのロールは変更できません。'
  if (r.error === 'last_channel_manager') return 'チャンネルの管理者がいなくなるため、ロールを変更できません。先に別のオーナーまたは管理者を追加してください。'
  if (r.error === 'invite_sign_in_required') return 'このアドレスのアカウントでログインしてから招待を受けてください。'
  if (r.error === 'invite_account_mismatch') return '招待先のアカウントでログインしてください。'
  if (r.error === 'invite_issuer_unauthorized') return '招待したメンバーの権限が変更されています。組織の管理者に新しい招待を依頼してください。'
  if (r.error === 'member_already_active') return 'すでにこの組織のメンバーです。'
  if (r.error === 'invite_unavailable') return 'この招待は利用できません。招待先アドレスと有効期限を確認してください。'
  if (r.error === 'invite_limit_reached') return '有効な招待が上限に達しています。不要な招待を取り消してから、もう一度お試しください。'
  if (isSessionEnded(r)) return sessionEndedMessage
  if (r.status === 403) return 'この操作の権限がありません。'
  return '入力内容と権限を確認してください。'
}
