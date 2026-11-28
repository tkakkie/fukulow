import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Request, Runner } from './backup-curl.ts'
import { listObjects } from './backup-r2-list.ts'
import { objectTransport } from './backup-r2.ts'
import { response, item, page, scopes, withScope } from './backup-r2-list-test-helpers.ts'
import { now } from './backup-r2-test-helpers.ts'

test('listing follows opaque continuation tokens and returns every page with decoded keys', async () => {
  const calls: Request[] = [], token = 'opaque+/=&<token'
  const run: Runner = async r => { calls.push(r); return response(calls.length === 1 ? page([item('one&<')], true, token) : page([item('two')])) }
  assert.deepEqual((await objectTransport(run).list()).map(o => o.key), ['one&<', 'two'])
  assert.equal(calls[0].query?.['list-type'], '2')
  assert.equal(calls[1].query?.['continuation-token'], token)
})

test('listing fails closed on missing repeated inconsistent tokens and a page cap', async () => {
  const malformed = [page([item()], true), page([item()], true, ''), page([item()], false, 'unexpected'),
    page([], true, 'token'), page([item()]).replace('<KeyCount>1', '<KeyCount>2'),
    page([item()]).replace('false', 'maybe'), page([item()]).replace('</ListBucketResult>', '<ContinuationToken>wrong</ContinuationToken></ListBucketResult>')]
  for (const body of malformed) await assert.rejects(listObjects(async () => response(body)))
  await assert.rejects(listObjects(async () => response(page([item()], true, 'token')), 1), /cap/)
  let n = 0
  await assert.rejects(listObjects(async () => response(page([item(String(++n))], true, 'same'))), /repeated/)
  n = 0
  await assert.rejects(listObjects(async () => response(page([item()], ++n === 1, n === 1 ? 'next' : undefined))), /object/)
  await assert.rejects(listObjects(async () => response('', 503)), /failed/)
})

test('listing rejects malformed XML unsafe entities invalid metadata and truncated response', async () => {
  for (const body of ['<!DOCTYPE x [<!ENTITY secret SYSTEM "private">]>' + page([item()]), page([item()]).slice(0, -1),
    page([item()]).replace('<Size>7', '<Size>-1'), page([item()]).replace('<Size>7', '<Size>9007199254740992'),
    page([item()]).replace('object', '&unknown;'), page([item()]).replace('object', 'bad&entity'),
    page([item()]).replace(new Date(now).toISOString(), 'invalid'), page([item()]).replace('</Key>', '</Size>')]) {
    await assert.rejects(listObjects(async () => response(body)))
  }
  await assert.rejects(listObjects(async () => response(page([])), 0))
})

test('listing rejects filtering grouping encoding and scope changes on every page', async () => {
  for (const scope of scopes) {
    await assert.rejects(listObjects(async () => response(withScope(page([item()]), scope))), /listing/)
    let calls = 0
    await assert.rejects(listObjects(async () => response(++calls === 1
      ? withScope(page([item('one')], true, 'next'), '<Prefix/><Delimiter/>')
      : withScope(page([item('two')]), scope))), /listing/)
    assert.equal(calls, 2)
  }
  assert.equal((await listObjects(async () => response(withScope(page([item()]), '<Prefix/><Delimiter/><StartAfter/>')))).length, 1)
})
