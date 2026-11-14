import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
const output = process.env.ACTIVITY_SEED_OUT
const checkout = resolve(import.meta.dirname, '..')
if (!output || resolve(output).startsWith(checkout + sep)) throw new Error('ACTIVITY_SEED_OUT must name a path outside the checkout')
const container = process.env.ACTIVITY_DB_CONTAINER || 'fukulow-pg-307'
const org = randomUUID(), channel = randomUUID(), topic = randomUUID()
const tokens: string[] = [], sql: string[] = ['BEGIN;', `INSERT INTO organizations (organization_id,name) VALUES ('${org}','Activity load');`]
for (let index = 0; index < 313; index++) {
  const account = randomUUID(), member = randomUUID(), token = randomBytes(32).toString('hex')
  tokens.push(token)
  const hash = createHash('sha256').update(token).digest('hex')
  sql.push(`INSERT INTO accounts (id,email,password_hash) VALUES ('${account}','activity-${account}@example.invalid','unused');`,
    `INSERT INTO users (organization_id,id,account_id,name,role) VALUES ('${org}','${member}','${account}','Load ${index}','member');`,
    `INSERT INTO account_sessions (account_id,token_hash) VALUES ('${account}',decode('${hash}','hex'));`)
  if (index === 0) {
    sql.push(`INSERT INTO channels (organization_id,id,name,visibility) VALUES ('${org}','${channel}','Load channel','public');`,
      `INSERT INTO channel_members (organization_id,channel_id,member_id) VALUES ('${org}','${channel}','${member}');`,
      `INSERT INTO channel_message_sequences (organization_id,channel_id,seq) VALUES ('${org}','${channel}',1);`,
      `INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count) VALUES ('${org}','${channel}','${topic}','Load topic',1,1,1);`,
      `INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id) VALUES ('${org}','${randomUUID()}','${channel}',1,'${member}','${randomUUID()}','load','${topic}');`)
  }
}
for (let index = 1; index < 10; index++) sql.push(`INSERT INTO channels (organization_id,id,name,visibility) VALUES ('${org}','${randomUUID()}','Load ${index}','public');`)
sql.push('COMMIT;')
const result = spawnSync('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'fukulow', '-v', 'ON_ERROR_STOP=1'], { input: sql.join('\n'), encoding: 'utf8' })
if (result.status !== 0) throw new Error('Disposable load seed failed; no credentials printed')
writeFileSync(output, JSON.stringify({ organization: org, channel, topic, tokens }), { mode: 0o600 })
console.log('Seeded 313 Accounts, 313 Sessions, 10 Channels and one Topic')
