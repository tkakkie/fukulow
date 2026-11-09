import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildDriver } from './check-module-direction.ts'

test('module direction uses compiler resolution in production and tests', async (t) => {
  const driver = buildDriver()
  const directory = mkdtempSync(join(tmpdir(), 'fukulow-module-direction-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  function compile(source: string, checked: boolean, tests = false, extra: string[] = []) {
    const file = join(directory, 'lib.rs')
    writeFileSync(file, `#![allow(dead_code, unused_imports)]\n${source}`)
    return spawnSync(checked ? driver : 'rustc', [
      '--edition=2024', '--crate-name', 'fixture', '--crate-type', 'lib',
      '--emit=metadata', '--out-dir', directory,
      ...(tests ? ['--test'] : []), ...extra, file,
    ], { encoding: 'utf8' })
  }

  const denied: Record<string, string> = {
    'direct import': 'use crate::messages::Message;',
    'grouped import': 'use crate::{auth::Identity, messages::{Message as Alias}};',
    'code path': 'fn f() { let _ = crate::messages::Message; }',
    'super path': 'mod inner { fn f(_: super::super::messages::Message) {} }',
    'module alias': 'use crate::messages as bridge; fn f(_: bridge::Message) {}',
    'root module alias': 'fn f(_: crate::bridge::Message) {}',
    'root item re-export': 'fn f(_: crate::ReExport) {}',
    'public re-export': 'pub use crate::messages::Message;',
    'glob import': 'use crate::messages::*;',
    'nested grouped glob': 'use crate::{messages::{self as bridge, *}};',
    're-export counterexample': 'fn f(_: crate::messages::Channel) {}',
    're-export import counterexample': 'use crate::messages::Channel as Alias;',
    're-export alias counterexample': 'use crate::messages as bridge; fn f(_: bridge::Channel) {}',
    'raw identifier': 'fn f(_: crate::r#messages::Message) {}',
    'type-relative associated function': 'fn f() { crate::channels::Channel::higher(); }',
    'inferred method': 'fn f(channel: crate::channels::Channel) { channel.higher_method(); }',
    'macro generated path': 'macro_rules! emit { () => { fn f(_: crate::messages::Message) {} }; } emit!();',
    'macro generated import': 'macro_rules! emit { () => { use crate::messages::Channel as Alias; }; } emit!();',
    'macro generated alias': 'macro_rules! emit { () => { use crate::messages as bridge; fn f(_: bridge::Channel) {} }; } emit!();',
    'macro generated module': 'macro_rules! emit { () => { mod inner { fn f(_: crate::messages::Message) {} } }; } emit!();',
    'empty macro invocation': 'crate::messages::empty!();',
    'empty macro through root alias': 'crate::bridge::empty!();',
    'empty macro re-export counterexample': 'crate::messages::lower_empty!();',
    'macro re-export through root alias': 'crate::bridge::lower_empty!();',
    'macro through absolute self-crate alias': '::this::messages::lower_empty!();',
    'macro through relative self-crate alias': 'this::messages::lower_empty!();',
    'macro through block-local self-crate alias': 'fn f() { extern crate self as local; local::messages::lower_empty!(); }',
    'macro through raw module identifier': 'crate::r#messages::lower_empty!();',
    'nested empty macro': 'macro_rules! emit { () => { crate::messages::lower_empty!(); }; } emit!();',
    'empty macro super path': 'mod inner { super::super::messages::lower_empty!(); }',
  }

  function fixture(body: string): string {
    return `
extern crate self as this;
pub use messages as bridge;
pub use messages::Message as ReExport;
pub mod auth { pub struct Identity; }
pub mod channels {
    pub struct Channel;
    macro_rules! lower_empty { () => {}; }
    pub(crate) use lower_empty;
    ${body}
}
pub mod messages {
    pub struct Message;
    pub use crate::channels::Channel;
    pub(crate) use crate::channels::lower_empty;
    macro_rules! empty { () => {}; }
    pub(crate) use empty;
    impl Channel {
        pub fn higher() {}
        pub fn higher_method(&self) {}
    }
}
pub mod realtime {}
`
  }

  for (const [name, body] of Object.entries(denied)) {
    await t.test(name, () => {
      const source = fixture(body)
      const baseline = compile(source, false)
      assert.equal(baseline.status, 0, `invalid negative fixture: ${baseline.stderr}`)
      const result = compile(source, true)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /module direction: channels must not reference messages/)
    })
  }

  function stateFixture(body: string): string {
    return `
pub struct AppState {
    pub hub: realtime::Hub,
    pub boxed: Box<realtime::Hub>,
    pub tuple: realtime::Tuple,
    pub indirect: Handle,
    pub count: u8,
}
pub struct Handle(pub realtime::Hub);
impl std::ops::Deref for Handle {
    type Target = realtime::Hub;
    fn deref(&self) -> &Self::Target { &self.0 }
}
pub type Alias = realtime::Hub;
pub type Chain = Alias;
pub type Wrapped = Option<&'static Chain>;
pub type Generic<T> = (T, Chain);
pub type ThroughReExport = realtime::Identity;
pub type Allowed = auth::Identity;
pub mod auth { pub struct Identity; ${body} }
pub mod channels {}
pub mod messages {}
pub mod realtime {
    pub struct Hub { pub count: u8 }
    pub struct Tuple(pub u8);
    pub use crate::auth::Identity;
    fn allowed(_: crate::Allowed) {}
}
`
  }

  const stateDenied = {
    'AppState field read': 'fn f(s: &crate::AppState) -> u8 { s.hub.count }',
    'AppState field write': 'fn f(s: &mut crate::AppState) { s.hub.count = 1; }',
    'AppState tuple struct field': 'fn f(s: &crate::AppState) -> u8 { s.tuple.0 }',
    'AppState built-in autoderef field': 'fn f(s: &crate::AppState) -> u8 { s.boxed.count }',
    'AppState custom autoderef field': 'fn f(s: &crate::AppState) -> u8 { s.indirect.count }',
    'macro-generated AppState field': 'macro_rules! emit { () => { fn f(s: &crate::AppState) -> u8 { s.hub.count } }; } emit!();',
    'root type alias': 'fn f(_: crate::Alias) {}',
    'root type alias chain': 'fn f(_: crate::Chain) {}',
    'root type alias inside container': 'fn f(_: crate::Wrapped) {}',
    'root generic type alias': 'fn f(_: crate::Generic<u8>) {}',
    'root type alias retaining re-export module': 'fn f(_: crate::ThroughReExport) {}',
    'imported root type alias': 'use crate::Alias as Local; fn f(_: Local) {}',
    'macro-generated root type alias use': 'macro_rules! emit { () => { fn f(_: crate::Alias) {} }; } emit!();',
  }

  for (const [name, body] of Object.entries(stateDenied)) {
    await t.test(name, () => {
      for (const tests of [false, true]) {
        const source = stateFixture(tests ? `#[cfg(test)] mod tests { ${body} }` : body)
        const baseline = compile(source, false, tests)
        assert.equal(baseline.status, 0, `invalid negative fixture: ${baseline.stderr}`)
        const result = compile(source, true, tests)
        assert.equal(result.status, 1, result.stderr)
        assert.match(result.stderr, /module direction: auth must not reference realtime/)
      }
    })
  }

  await t.test('permitted fields, tuples and root type aliases pass', () => {
    const source = stateFixture(`
fn f(s: &crate::AppState, pair: (u8, u8), _: crate::Allowed) -> u8 { s.count + pair.0 }
`)
    const baseline = compile(source, false)
    assert.equal(baseline.status, 0, baseline.stderr)
    const result = compile(source, true)
    assert.equal(result.status, 0, result.stderr)
  })

  await t.test('composition-root field forwarding fails on inferred types', () => {
    for (const tests of [false, true]) {
      const body = 'fn f(s: &crate::AppState) { let _forwarded = &s.hub; }'
      const source = stateFixture(tests ? `#[cfg(test)] mod tests { ${body} }` : body)
      const baseline = compile(source, false, tests)
      assert.equal(baseline.status, 0, `invalid negative fixture: ${baseline.stderr}`)
      const result = compile(source, true, tests)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /module direction: auth must not reference realtime/)
    }
  })

  function inferredFixture(body: string): string {
    return `
pub struct AppState {
    pub identity: auth::Identity,
    pub channel: channels::Channel,
    pub hub: realtime::Hub,
}
pub struct W(realtime::Hub);
impl W { pub fn count(&self) -> u8 { self.0.count } }
impl std::ops::Deref for W {
    type Target = realtime::Hub;
    fn deref(&self) -> &Self::Target { &self.0 }
}
pub struct Generic<T>(pub T);
pub fn make_state() -> AppState {
    AppState { identity: auth::Identity, channel: channels::Channel, hub: make() }
}
pub fn make() -> realtime::Hub { realtime::Hub { count: 1 } }
pub fn make_ref() -> &'static realtime::Hub { &realtime::Hub { count: 1 } }
pub fn make_generic() -> Option<Vec<realtime::Hub>> { None }
pub fn make_tuple() -> (u8, realtime::Hub) { (0, make()) }
pub fn make_array() -> [realtime::Hub; 1] { [make()] }
pub fn make_root_generic() -> Generic<realtime::Hub> { Generic(make()) }
pub fn consume(_: &dyn channels::Count) {}
pub fn consume_hub(_: &realtime::Hub) {}
pub mod auth { pub struct Identity; }
pub mod channels {
    pub struct Channel;
    pub trait Count { fn count(&self) -> u8; }
    ${body}
}
pub mod messages {}
pub mod realtime {
    pub struct Hub { pub count: u8 }
    impl crate::channels::Count for Hub { fn count(&self) -> u8 { self.count } }
}
`
  }

  const inferredDenied = {
    'inferred root return forwarded in a vector': 'fn f() { let h = crate::make(); drop(vec![h]); }',
    'inferred reference return': 'fn f() { let h = crate::make_ref(); drop(h); }',
    'inferred generic container return': 'fn f() { let h = crate::make_generic(); drop(h); }',
    'inferred tuple return': 'fn f() { let h = crate::make_tuple(); drop(h); }',
    'inferred array return': 'fn f() { let h = crate::make_array(); drop(h); }',
    'inferred root ADT generic argument': 'fn f() { let h = crate::make_root_generic(); drop(h); }',
    'inferred expression without a binding': 'fn f() { drop(crate::make()); }',
    'inferred expression before trait-object coercion': 'fn f() { crate::consume(&crate::make()); }',
    'inferred expression after autoderef coercion': 'fn f(w: &crate::W) { crate::consume_hub(w); }',
    'inferred binding from root struct destructuring': 'fn f(s: &crate::AppState) { let crate::AppState { hub: _h, .. } = s; }',
    'inferred binding in a match': 'fn f(s: &crate::AppState) { match s { crate::AppState { hub: _h, .. } => {} } }',
    'inferred closure body': 'fn f() { let _f = || { let _h = crate::make(); }; }',
    'inferred async body': 'async fn f() { let _h = crate::make(); }',
    'macro-generated inferred binding': 'macro_rules! emit { () => { fn f() { let _h = crate::make(); } }; } emit!();',
  }

  for (const [name, body] of Object.entries(inferredDenied)) {
    await t.test(name, () => {
      for (const tests of [false, true]) {
        const source = inferredFixture(tests ? `#[cfg(test)] mod tests { ${body} }` : body)
        const baseline = compile(source, false, tests)
        assert.equal(baseline.status, 0, `invalid negative fixture: ${baseline.stderr}`)
        const result = compile(source, true, tests)
        assert.equal(result.status, 1, result.stderr)
        assert.match(result.stderr, /module direction: channels must not reference realtime/)
      }
    })
  }

  await t.test('known limitation: root nominal wrapper internals remain review-enforced', () => {
    for (const tests of [false, true]) {
      // W's fields and method bodies belong to the composition root. The lower
      // module holds only W, whose nominal type does not expose realtime::Hub.
      const body = 'fn f(w: &crate::W) -> u8 { w.count() }'
      const source = inferredFixture(tests ? `#[cfg(test)] mod tests { ${body} }` : body)
      const baseline = compile(source, false, tests)
      assert.equal(baseline.status, 0, baseline.stderr)
      const result = compile(source, true, tests)
      assert.equal(result.status, 0, result.stderr)
    }
  })

  await t.test('AppState lower fields and root-fed generic and trait dependency injection pass', () => {
    const body = `
pub fn keep<T>(value: T) -> T { value }
pub fn keep_array<T>(value: [T; 1]) -> [T; 1] { value }
pub fn count<T: Count>(value: &T) -> u8 { value.count() }
pub fn count_dyn(value: &dyn Count) -> u8 { value.count() }
pub fn lower_fields(s: &crate::AppState) {
    let _identity = &s.identity;
    let _channel = &s.channel;
    let crate::AppState { identity: _a, channel: _c, .. } = s;
    let _state = crate::AppState { channel: Channel, ..crate::make_state() };
}
`
    for (const tests of [false, true]) {
      const source = inferredFixture(body) + `
${tests ? '#[cfg(test)] #[test]' : ''}
fn root() {
    let s = AppState { identity: auth::Identity, channel: channels::Channel, hub: make() };
    channels::lower_fields(&s);
    channels::keep(&s.hub);
    channels::keep_array([crate::make()]);
    channels::count(&s.hub);
    channels::count_dyn(&s.hub);
}
`
      const baseline = compile(source, false, tests)
      assert.equal(baseline.status, 0, baseline.stderr)
      const result = compile(source, true, tests)
      assert.equal(result.status, 0, result.stderr)
    }
  })

  await t.test('inferred root returns enforce every reverse pair and allow forward pairs', () => {
    const names = ['auth', 'channels', 'messages', 'realtime']
    for (let from = 0; from < names.length; from++) {
      for (let to = 0; to < names.length; to++) {
        const source = `pub fn make() -> ${names[to]}::Item { ${names[to]}::Item }\n` +
          names.map((name, index) => `pub mod ${name} {
            pub struct Item;
            ${index === from ? 'fn f() { let _value = crate::make(); }' : ''}
          }`).join('\n')
        const baseline = compile(source, false)
        assert.equal(baseline.status, 0, `invalid fixture: ${baseline.stderr}`)
        const result = compile(source, true)
        assert.equal(result.status, to > from ? 1 : 0, result.stderr)
        if (to > from) assert.match(result.stderr,
          new RegExp(`module direction: ${names[from]} must not reference ${names[to]}`))
      }
    }
  })

  await t.test('all reverse pairs fail and forward pairs pass', () => {
    const names = ['auth', 'channels', 'messages', 'realtime']
    for (let from = 0; from < names.length; from++) {
      for (let to = 0; to < names.length; to++) {
        const source = names.map((name, index) => `pub mod ${name} {
          pub struct Item;
          ${index === from ? `fn f(_: crate::${names[to]}::Item) {}` : ''}
        }`).join('\n')
        const result = compile(source, true)
        assert.equal(result.status, to > from ? 1 : 0, result.stderr)
      }
    }
  })

  await t.test('composition roots, forward re-exports, external paths and shadowing pass', () => {
    const valid = compile(`
pub mod auth { pub struct Identity; }
pub mod channels {
  pub use crate::auth::Identity;
  mod messages { pub struct Local; }
  fn f(_: messages::Local, _: utoipa::openapi::Local) {}
  mod utoipa { pub mod openapi { pub struct Local; } }
}
pub mod messages { pub use crate::channels::Identity; }
pub mod realtime { use crate::{auth::*, channels, messages}; pub struct Item; }
pub mod openapi { use crate::realtime; }
fn main() { let _: Option<realtime::Item> = None; }
mod lib { use crate::realtime; }
`, true)
    assert.equal(valid.status, 0, valid.stderr)
  })

  await t.test('block-local macro aliases shadow root module names', () => {
    const source = fixture(`
fn f() { use crate::channels as messages; messages::lower_empty!(); }
fn g() { extern crate self as local; local::channels::lower_empty!(); }
`)
    const baseline = compile(source, false)
    assert.equal(baseline.status, 0, baseline.stderr)
    const result = compile(source, true)
    assert.equal(result.status, 0, result.stderr)
  })

  await t.test('include files retain their invocation module', () => {
    for (const [body, status] of [
      ['crate::messages::lower_empty!();', 1],
      ['crate::channels::lower_empty!();', 0],
    ] as const) {
      writeFileSync(join(directory, 'included.rs'), body)
      const source = fixture('include!("included.rs");')
      const baseline = compile(source, false)
      assert.equal(baseline.status, 0, baseline.stderr)
      const result = compile(source, true)
      assert.equal(result.status, status, result.stderr)
      if (status) assert.match(result.stderr, /module direction: channels must not reference messages/)
    }
  })

  await t.test('procedural macros and higher-module re-exports of external macros are checked', () => {
    const source = join(directory, 'macros.rs')
    const library = join(directory, `libfixture_macros.${process.platform === 'darwin' ? 'dylib' : 'so'}`)
    writeFileSync(source, `
extern crate proc_macro;
use proc_macro::TokenStream;
#[proc_macro]
pub fn empty(_: TokenStream) -> TokenStream { TokenStream::new() }
#[proc_macro_attribute]
pub fn emit(_: TokenStream, _: TokenStream) -> TokenStream {
    "pub mod channels { fn f(_: crate::messages::Message) {} }".parse().unwrap()
}
`)
    const built = spawnSync('rustc', ['--edition=2024', '--crate-name', 'fixture_macros', '--crate-type', 'proc-macro', source, '-o', library], { encoding: 'utf8' })
    assert.equal(built.status, 0, built.stderr)
    const extra = ['--extern', `fixture_macros=${library}`]
    for (const source of [
      '#[fixture_macros::emit] mod channels {} mod messages { pub struct Message; }',
      'mod channels { crate::messages::empty!(); } mod messages { pub use fixture_macros::empty; }',
    ]) {
      const baseline = compile(source, false, false, extra)
      assert.equal(baseline.status, 0, baseline.stderr)
      const result = compile(source, true, false, extra)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /module direction: channels must not reference messages/)
    }
    const allowed = compile('mod channels { fixture_macros::empty!(); }', true, false, extra)
    assert.equal(allowed.status, 0, allowed.stderr)
  })

  await t.test('Cargo wrapper checks unit-test imports and propagates failures', () => {
    writeFileSync(join(directory, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.0.0"\nedition="2024"\n[lib]\npath="lib.rs"\n[workspace]\n')
    const cargo = () => spawnSync('cargo', ['check', '--offline', '--all-targets'], {
      cwd: directory, encoding: 'utf8',
      env: { ...process.env, RUSTC_WORKSPACE_WRAPPER: driver, CARGO_TARGET_DIR: join(directory, 'target') },
    })
    compile(fixture('#[cfg(test)] mod tests { use crate::messages::Channel; }'), false)
    const denied = cargo()
    assert.equal(denied.status, 101, denied.stderr)
    assert.match(denied.stderr, /module direction: channels must not reference messages/)
    compile(fixture(''), false)
    const allowed = cargo()
    assert.equal(allowed.status, 0, allowed.stderr)
  })

  await t.test('cfg(test) imports are checked without breaking production', () => {
    const source = fixture('#[cfg(test)] mod tests { use crate::messages::Channel; #[test] fn f() {} }')
    assert.equal(compile(source, true).status, 0)
    assert.equal(compile(source, false, true).status, 0)
    const result = compile(source, true, true)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /module direction: channels must not reference messages/)
  })

  await t.test('new module files and path attributes are included by rustc', () => {
    mkdirSync(join(directory, 'channels'), { recursive: true })
    writeFileSync(join(directory, 'channels/new_file.rs'), 'use crate::messages::Channel;')
    writeFileSync(join(directory, 'elsewhere.rs'), 'use crate::messages::Channel;')
    for (const declaration of ['mod new_file;', '#[path = "../elsewhere.rs"] mod new_file;']) {
      const source = fixture(declaration)
      assert.equal(compile(source, false).status, 0)
      const result = compile(source, true)
      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /module direction: channels must not reference messages/)
    }
  })
})
