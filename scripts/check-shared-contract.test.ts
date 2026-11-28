import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkContract, constants, loadRepo, type Repo, serverCodes } from './check-shared-contract.ts'

const repo = loadRepo(fileURLToPath(new URL('../', import.meta.url)))

function edit(file: string, from: string, to: string, base: Repo = repo): Repo {
  assert.ok(base.files[file]?.includes(from), `${file} must contain ${from}`)
  return { ...base, files: { ...base.files, [file]: base.files[file].replace(from, to) } }
}

test('server, client-core, web and openapi.json agree on shared error codes and limits', (t) => {
  const pairs = checkContract(repo)
  for (const pair of pairs) t.diagnostic(pair)
  for (const expected of [
    'error code history_generation_changed: server = core = web',
    'message body 4000: server/src/messages/send.rs = openapi.json SendMessageRequest/properties/body',
    'Section name 60: openapi.json = web/src/section-ui.ts SECTION_NAME_MAX',
    'message body 4000: openapi.json = web/src/message-rules.ts MESSAGE_BODY_MAX',
    'error code channel not found: server = web',
    'SYNC_MESSAGE_LIMIT 600: client-core/src/types.rs = web/src/protocol-types.ts',
  ]) assert.ok(pairs.includes(expected), expected)
})

test('a changed error code on one side fails', () => {
  assert.throws(() => checkContract(edit('server/src/messages/error.rs',
    '(StatusCode::CONFLICT, "snapshot_expired")', '(StatusCode::CONFLICT, "snapshot_stale")')), /snapshot_expired: server\/src product code never emits/)
  assert.throws(() => checkContract(edit('client-core/src/transitions.rs',
    'Some("snapshot_expired")', 'Some("snapshot_stale")')), /snapshot_expired: core no longer matches/)
  assert.throws(() => checkContract(edit('web/src/section-ui.ts',
    "result.error === 'section_limit'", "result.error === 'section_limits'")), /section_limit: web no longer matches/)
  assert.throws(() => checkContract(edit('server/src/auth.rs',
    '"channel name already exists"', '"channel name exists"')), /channel name already exists: server\/src product code never emits/)
})

test('a code web or client-core matches but the server does not emit fails', () => {
  const file = 'web/src/section-ui.ts'
  assert.throws(() => checkContract(edit(file, "result.error === 'section_limit'",
    "result.error === 'section_limit' || result.error === 'section_quota'")), /section_quota: matched by web but not in sharedCodes/)
  assert.throws(() => checkContract(edit('client-core/src/transitions.rs',
    'code == "subscription_limit"', 'code == "subscription_limit" || code == "too_many"')), /too_many: matched by client-core/)
  assert.throws(() => checkContract({ ...repo, files: { ...repo.files,
    'server/src/extra.rs': 'fn e() -> ApiError { ApiError(StatusCode::FORBIDDEN, "incorrect", None) }' } }), /web-only code incorrect: the server also emits it/)
})

test('a changed limit on one side fails', () => {
  assert.throws(() => checkContract(edit('client-core/src/types.rs',
    'MAIN_MESSAGE_LIMIT: usize = 400', 'MAIN_MESSAGE_LIMIT: usize = 401')), /MAIN_MESSAGE_LIMIT: web\/src\/protocol-types.ts differs/)
  assert.throws(() => checkContract(edit('web/src/protocol-types.ts',
    'TOTAL_MESSAGE_LIMIT = 1500', 'TOTAL_MESSAGE_LIMIT = 1600')), /TOTAL_MESSAGE_LIMIT: web\/src\/protocol-types.ts differs/)
  assert.throws(() => checkContract(edit('web/src/section-ui.ts',
    'SECTION_NAME_MAX = 60', 'SECTION_NAME_MAX = 61')), /Section name: web\/src\/section-ui.ts SECTION_NAME_MAX differs/)
  assert.throws(() => checkContract(edit('server/src/messages/send.rs',
    'self.body.chars().count() > 4000', 'self.body.chars().count() > 5000')), /message body: server\/src\/messages\/send.rs allows 5000/)
  assert.throws(() => checkContract(edit('server/src/channels.rs',
    'name.chars().count() > 128', 'name.chars().count() > 100')), /Channel name: server\/src\/channels.rs allows 100/)
  assert.throws(() => checkContract(edit('web/src/message-rules.ts',
    'TOPIC_NAME_MAX = 60', 'TOPIC_NAME_MAX = 64')), /Topic name: web\/src\/message-rules.ts TOPIC_NAME_MAX differs/)
  assert.throws(() => checkContract(edit('web/src/channels.ts',
    'CHANNEL_NAME_MAX = 128', 'CHANNEL_NAME_MAX = 120')), /Channel name: web\/src\/channels.ts CHANNEL_NAME_MAX differs/)
})

test('server codes ignore comments, descriptions and test modules', () => {
  const only = (files: Record<string, string>) => serverCodes({ files, openapi: {} })
  const emit = (code: string) => `fn e() -> ApiError { ApiError(StatusCode::CONFLICT, "${code}", None) }`
  assert.deepEqual([...only({
    'server/src/a.rs': `// ApiError(StatusCode::CONFLICT, "commented", None)\n#[utoipa::path(responses((status = 409, description = "described")))]\n${emit('kept')}\n` +
      `#[cfg(test)]\nmod tests {\n    fn f<'a>(x: &'a str) -> char { let _ = "}"; '}' }\n    ${emit('inline_test')}\n}\n#[cfg(test)]\nmod outlined;\n${emit('after_tests')}\n`,
    'server/src/a/outlined.rs': emit('outlined_test'),
    'server/src/a/tests/deep.rs': emit('nested_test'),
    'server/src/lib.rs': `#[cfg(test)]\npub(crate) mod a;\n`,
  })], [])
  assert.deepEqual([...only({
    'server/src/a.rs': `${emit('kept')}\n#[cfg(test)]\nmod tests {\n    fn f() -> char { let _ = "}"; '}' }\n    ${emit('inline_test')}\n}\n${emit('after_tests')}\n`,
    'server/src/a/tests/deep.rs': emit('nested_test'),
  })].sort(), ['after_tests', 'kept'])
})

test('limit expressions resolve earlier constants', () => {
  assert.deepEqual(constants('export const A = 10\nexport const B = 3\nexport const C = A - B + 1\nexport const D = A * 2\n', false),
    new Map([['A', 10], ['B', 3], ['C', 8]]))
  assert.deepEqual(constants('pub const A: usize = 10;\npub const C: usize =\n    A - 4;\n', true), new Map([['A', 10], ['C', 6]]))
})
