import { describe, expect, it } from 'vitest'
import { checkCoreDependencies, checkCoreSource, checkRustCore } from './protocol-imports.ts'
describe('Rust core purity guard (not transitive purity)', () => {
  it('rejects I/O clock randomness imports aliases and calls with negative controls', () => {
    for (const source of ['use std::fs;', 'use std::{time::Instant as Clock};', 'use std::{net, io};',
      'std::thread::spawn(f);', 'std::env::var("HOME");', 'Uuid::new_v4();',
      'println!("I/O");', 'use rand::random as r;', 'use web_sys::Window;', 'extern "C" {}', 'include!("other.rs");']) {
      expect(checkCoreSource(source), source).not.toEqual([])
    }
    expect(checkCoreSource('use std::{collections::BTreeMap, rc::Rc}; use uuid::Uuid;')).toEqual([])
  })
  it('rejects added dependencies renamed dependencies and randomness features with negative controls', () => {
    for (const extra of ['tokio = "1"', 'rand = "1"', 'serde = { package = "reqwest", version = "1" }',
      'uuid = { version = "1", features = ["v4"] }', 'uuid = { version = "1", features = ["js"] }',
      'uuid = {\n version = "1",\n features = ["v4"]\n}', '[dependencies.serde]\npackage = "reqwest"']) {
      expect(checkCoreDependencies(`[dependencies]\n${extra}`), extra).not.toEqual([])
    }
    expect(checkCoreDependencies('[features]\nrng = ["uuid/v4"]')).not.toEqual([])
    expect(checkCoreDependencies('[target.x.dependencies]\nreqwest = "1"')).not.toEqual([])
    expect(checkCoreDependencies('[dependencies]\nserde = { version = "1", features = ["derive", "rc"] }\nuuid = { version = "1", features = ["serde"] }')).toEqual([])
  })
  it('the Rust core passes the source and dependency purity guard', () => {
    expect(checkRustCore(new URL('../../client-core', import.meta.url).pathname)).toEqual([])
  })
})
