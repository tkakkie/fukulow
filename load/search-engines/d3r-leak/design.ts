export const formal = {blocksPerArm: 10, clients: 5, measuredPerClient: 20, messages: 24_000, many: 1_000};
export const smoke = {blocksPerArm: 2, clients: 2, measuredPerClient: 8, messages: 600, many: 40};
export const rehearsal = {...formal, blocksPerArm: 1};
export type Design = typeof formal;

export const queries = {Q2: 'zx', Q4: 'qvwx'};
export type Query = keyof typeof queries;
export const scopes = ['C1', 'C2', 'C3'] as const;
export type Scope = typeof scopes[number];
export const judgedIds = scopes.flatMap(scope => (['Q2', 'Q4'] as const).map(query => `${scope}-${query}`));
export type Arm = 'few' | 'many';
export const arms = ['few', 'many'] as const;

export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
  };
}

export function schedule(ids: readonly string[], seed: number, blocksPerArm: number) {
  const next = random(seed);
  return ids.map(id => {
    const start = next() < .5 ? 0 : 1;
    return {id, blocks: Array.from({length: 2 * blocksPerArm}, (_, index) =>
      arms[start ^ Number(index % 4 === 1 || index % 4 === 2)])};
  });
}
