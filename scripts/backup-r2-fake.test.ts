import assert from 'node:assert/strict'
import { test } from 'node:test'
import { epoch, fakeS3 } from './backup-r2-fake.ts'
import { checksum } from './backup-r2-inventory.ts'
import { sha256 } from './backup-r2-model.ts'
import { objectTransport } from './backup-r2.ts'

test('fake rejects incorrect PUT digest and requires checksum mode', async t => {
  const fake = await fakeS3(() => epoch); t.after(fake.close)
  const run = fake.runner('backups'), body = Buffer.from('cipher')
  assert.equal((await run({ method: 'PUT', key: 'bad', body, headers: { 'x-amz-content-sha256': sha256('wrong'), 'x-amz-checksum-sha256': checksum(sha256(body)) } })).status, 400)
  await objectTransport(run).put('good', body)
  assert.equal((await run({ method: 'HEAD', key: 'good', headers: {} })).status, 400)
})
