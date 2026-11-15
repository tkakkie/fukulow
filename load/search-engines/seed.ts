import { closeSync, openSync, writeSync } from 'node:fs';

export const seed = 153202611;
export const epoch = Date.parse('2026-11-15T00:00:00Z');
export const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const org = (n: number) => uuid(n);
export const member = (o: number, n: number) => uuid(1000 + o * 100 + n);
export const channel = (o: number, n: number) => uuid(10000 + o * 100 + n);
const topic = (o: number, c: number, n: number) => uuid(100000 + o * 10000 + c * 20 + n);
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const phrases = [
  '本日の開発会議で検索の仕様を確認しました。', 'チームの進捗と次の作業を共有します。',
  'お疲れさまです。レビューをお願いします。', 'リリース前に動作を確認してください。',
  '資料を更新したので午後に相談しましょう。', 'テスト環境でAPI応答とログを調べています。',
  'バックアップと復元の手順を整理します。', '東京と大阪の担当者に連絡しました。',
  '接続が切れた場合は再試行します。', '画面の表示とキーボード操作を改善しました。',
  'ProjectAlpha42 の設定とbuildStatusを確認。', 'ご質問ありがとうございます。明日までに回答します。',
  'スケジュールと優先度はこのトピックで相談します。', '配送処理の負荷を測定しています。',
  'The deployment status is READY and PostgreSQL is available.'];

export function fixtureSql(): string {
  const sql: string[] = [];
  for (let o = 1; o <= 3; o++) {
    sql.push(`INSERT INTO organizations VALUES ('${org(o)}','Synthetic Organization ${o}');`);
    for (let u = 1; u <= 6; u++) {
      sql.push(`INSERT INTO accounts VALUES ('${member(o, u)}','synthetic-${o}-${u}@example.invalid','measurement-only');`);
      sql.push(`INSERT INTO users (organization_id,id,account_id,name,role) VALUES ('${org(o)}','${member(o, u)}','${member(o, u)}','Synthetic Member ${u}','${u === 1 ? 'owner' : u === 3 || u === 4 ? 'guest' : 'member'}');`);
    }
    for (let c = 0; c < 40; c++) {
      sql.push(`INSERT INTO channels VALUES ('${org(o)}','${channel(o,c)}','Synthetic Channel ${c}','${c % 2 ? 'private' : 'public'}');`);
      sql.push(`INSERT INTO channel_message_sequences VALUES ('${org(o)}','${channel(o,c)}',1);`);
      for (let t = 0; t < 8; t++) sql.push(`INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) VALUES ('${org(o)}','${channel(o,c)}','${topic(o,c,t)}','Topic ${t}',1,1,1);`);
      for (const u of [1,2,3,5]) if ((u === 1 && c < 20) || (u === 2 && c % 5 === 0) || (u === 3 && c < 8) || (u === 5 && c < 8)) {
        sql.push(`INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ('${org(o)}','${channel(o,c)}','${member(o,u)}');`);
      }
    }
    // Stale grants after reactivation and an inactive Member exercise distinct denials.
    sql.push(`UPDATE users SET deactivated_at='2026-11-01' WHERE organization_id='${org(o)}' AND id IN ('${member(o,5)}','${member(o,6)}');`);
    sql.push(`UPDATE users SET deactivated_at=NULL WHERE organization_id='${org(o)}' AND id='${member(o,5)}';`);
  }
  return sql.join('\n');
}

export function generate(path: string, count: number): Record<string, unknown> {
  let rng = seed;
  const next = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) / 4294967296; };
  const seq = new Map<string, number>();
  const roots = new Map<string, {id:string,topic:string}>();
  const lengths: number[] = [];
  const fd = openSync(path, 'w');
  let batch = '';
  let old = 0, replies = 0, topics = 0;
  for (let i = 1; i <= count; i++) {
    const r = next(); const o = r < .6 ? 1 : r < .85 ? 2 : 3;
    const c = next() < .2 ? 0 : Math.floor(next() * 40);
    const key = `${o}:${c}`; const s = (seq.get(key) ?? 0) + 1; seq.set(key, s);
    const id = uuid(1000000 + i);
    const bucket = next(); const target = bucket < .6 ? 45 + Math.floor(next()*100) : bucket < .9 ? 180 + Math.floor(next()*250) : bucket < .99 ? 650 : 1800;
    let body = '';
    while ([...body].length < target) body += phrases[Math.floor(next()*phrases.length)] + (next() < .3 ? '\n' : ' ');
    body += ` ticket${Math.floor(next()*100000)} `;
    if (i % 997 === 0) body += '麒麟便 特殊照合Z9 ØZ QZX 🦉';
    if (i % 101 === 0) body += 'がぎぐげご café CAFÉ Straße STRASSE Σίσυφος ｶﾀｶﾅ カタカナ ＡＢＣ ABC';
    if (i % 211 === 0) body += ' x%y a_b c\\d 開発  API 開発 API';
    if (i % 307 === 0) body = body.normalize('NFD');
    lengths.push([...body].length);
    let age = i % 10 === 0 ? 180 + next()*180 : next()*180;
    if (i<=3) age = 180 + (i-2)/86400;
    if (age > 180) old++;
    const date = new Date(epoch - age * 86400000).toISOString();
    const root = roots.get(key); const reply = root && i % 5 === 0 ? root.id : '\\N';
    if (reply !== '\\N') replies++;
    let t = i % 4 ? topic(o,c,Math.floor(next()*8)) : '\\N';
    if (reply!=='\\N' && root) t = root.topic;
    if (!root) roots.set(key, {id,topic:t});
    if (t !== '\\N') topics++;
    const escaped = body.replaceAll('\\','\\\\').replaceAll('\n','\\n').replaceAll('\t','\\t');
    batch += [org(o),id,channel(o,c),s,member(o,1),id,escaped,date,t,reply,reply].join('\t')+'\n';
    if (i % 1000 === 0) { writeSync(fd,batch); batch = ''; }
  }
  if (batch) writeSync(fd,batch); closeSync(fd);
  lengths.sort((a,b)=>a-b);
  return { seed,count,old,replies,topics,bodyScalars:{p50:lengths[Math.floor(count*.5)],p95:lengths[Math.floor(count*.95)],p99:lengths[Math.floor(count*.99)]} };
}

export const copySql = "COPY messages (organization_id,id,channel_id,seq,sender,client_message_id,body,created_at,topic_id,reply_to_id,reply_root_id) FROM '/tmp/messages.tsv';";
export const finishSql = `UPDATE channel_message_sequences s SET seq=x.seq FROM (SELECT organization_id,channel_id,max(seq) seq FROM messages GROUP BY 1,2) x WHERE s.organization_id=x.organization_id AND s.channel_id=x.channel_id;
UPDATE topics t SET first_seq=x.first_seq,last_seq=x.last_seq,message_count=x.n FROM (SELECT organization_id,topic_id,min(seq) first_seq,max(seq) last_seq,count(*) n FROM messages WHERE topic_id IS NOT NULL GROUP BY 1,2) x WHERE t.organization_id=x.organization_id AND t.id=x.topic_id;
VACUUM ANALYZE;`;

// Rust str::trim uses Unicode White_Space, unlike JS trim (which also removes BOM).
export const trimQuery = (s: string) => s.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
export const literal = quote;
