import assert from 'node:assert/strict';
import { channel, member, org, uuid } from '../seed.ts';
import { formal, queries, scopes, type Design, type Query, type Scope } from './design.ts';

export const hit = uuid(1_000_000);
export const date = '2026-11-15T00:00:00Z';
export const visible = [0, 1, 2, 3, 4].map(c => channel(1, c));
export const hidden = {
  C1: {o: 2, c: 0}, C2: {o: 1, c: 5}, C3: {o: 1, c: 6},
};
export const allScopes = [...visible.map((_, c) => ({o: 1, c})), ...Object.values(hidden)];
const decoy = 'lmno';
const candidateBody = 'qvwy';

export type ArmFixture = {
  query: Query;
  scope?: Scope;
  slots: number;
  matches: number;
  candidates: number;
  extraForeignMessages?: number;
  afterVacuum?: boolean;
};

export type Pair = {id: string; few: ArmFixture; many: ArmFixture};

export const matchedBody = (query: Query) => query === 'Q2' ? queries.Q2 + 'ab' : queries.Q4;
export const slotBody = (arm: ArmFixture, slot: number) =>
  slot <= arm.matches ? matchedBody(arm.query) : slot <= arm.candidates ? candidateBody : decoy;

function foreignArm(scope: Scope, query: Query, slots: number, matches: number): ArmFixture {
  return {scope, query, slots, matches, candidates: 0};
}

export function judgedPairs(design: Design): Pair[] {
  return scopes.flatMap(scope => (['Q2', 'Q4'] as const).map(query => ({
    id: `${scope}-${query}`,
    few: foreignArm(scope, query, design.many, 1),
    many: foreignArm(scope, query, design.many, design.many),
  })));
}

export function positiveControl(k: number): Pair {
  const few: ArmFixture = {query: 'Q4', slots: k, matches: 0, candidates: 0};
  return {id: 'P', few, many: {...few, candidates: k}};
}

export function negativeControl(reference: ArmFixture): Pair {
  return {id: 'A/A', few: reference, many: {...reference}};
}

export function existence(scope: Scope, query: Query, design: Design): Pair {
  return {id: 'E', few: foreignArm(scope, query, design.many, 0),
    many: foreignArm(scope, query, design.many, design.many)};
}

export function globalSize(query: Query, design: Design): Pair {
  const few = foreignArm('C1', query, design.many, 0);
  return {id: 'S', few, many: {...few, extraForeignMessages: 9 * foreignMessageCount(few, design)}};
}

export function visibilityMap(scope: Scope, query: Query, design: Design, reference: ArmFixture): Pair {
  return {id: 'V', few: reference, many: {...foreignArm(scope, query, design.many, design.many), afterVacuum: true}};
}

export const slotScope = (arm: ArmFixture) => arm.scope ? hidden[arm.scope] : {o: 1, c: 0};
export const slotIds = (column: string, arm: ArmFixture) =>
  `${column} BETWEEN '${uuid(3_000_001)}' AND '${uuid(3_000_000 + arm.slots)}'`;
export const backgroundCount = (arm: ArmFixture, design: Design) => design.messages - arm.slots - 1;
export function foreignMessageCount(arm: ArmFixture, design: Design) {
  const otherOrg = allScopes.findIndex(scope => scope.o === 2);
  return Math.floor((backgroundCount(arm, design) + allScopes.length - otherOrg - 1) / allScopes.length) +
    (arm.scope === 'C1' ? arm.slots : 0);
}

export function baseFixtureSql() {
  const statements: string[] = [];
  for (const o of [1, 2]) {
    statements.push(`INSERT INTO organizations (organization_id,name) VALUES ('${org(o)}','Organization ${o}');`);
    for (const m of [1, 2, 3]) {
      const id = member(o, m);
      statements.push(`INSERT INTO accounts (id,email,password_hash) VALUES ('${id}','member-${o}-${m}@example.invalid','fixture');
        INSERT INTO users (organization_id,id,account_id,name,role) VALUES ('${org(o)}','${id}','${id}','Member ${m}','${m === 1 ? 'owner' : 'member'}');`);
    }
  }
  for (const {o, c} of allScopes) {
    const id = channel(o, c);
    if (c === 6) {
      statements.push(`INSERT INTO channels (organization_id,id,kind,lower_member_id,higher_member_id,created_at)
        VALUES ('${org(o)}','${id}','dm','${member(o, 1)}','${member(o, 3)}','${date}');
        INSERT INTO channel_members (organization_id,channel_id,member_id)
        VALUES ('${org(o)}','${id}','${member(o, 1)}'), ('${org(o)}','${id}','${member(o, 3)}');`);
    } else {
      statements.push(`INSERT INTO channels (organization_id,id,name,visibility,created_at)
        VALUES ('${org(o)}','${id}','Channel ${c}','${c === 5 ? 'private' : 'public'}','${date}');`);
      if (c === 5) statements.push(`INSERT INTO channel_members (organization_id,channel_id,member_id)
        VALUES ('${org(o)}','${id}','${member(o, 1)}');`);
    }
    statements.push(`INSERT INTO channel_message_sequences (organization_id,channel_id,seq) VALUES ('${org(o)}','${id}',1);`);
  }
  return statements.join('\n');
}

const nextId = (base: number) => `('00000000-0000-4000-8000-' || lpad(to_hex(${base} + i), 12, '0'))::uuid`;

function insert(o: number, c: number, rows: string) {
  return `INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,created_at)
    SELECT '${org(o)}', id, '${channel(o, c)}', seq, '${member(o, 1)}', id, body,
      '${date}'::timestamptz + seq * interval '1 second'
    FROM (${rows}) AS rows(id,seq,body) ORDER BY seq;`;
}

export function backgroundSql(arm: ArmFixture, design: Design) {
  const background = backgroundCount(arm, design);
  const rows = allScopes.map(({o, c}, offset) => {
    const count = Math.floor((background + allScopes.length - offset - 1) / allScopes.length);
    return insert(o, c, `SELECT ${nextId(1_100_000 + 100_000 * offset)}, i + ${o === 1 && c === 0 ? 1 : 0},
      '${decoy}' FROM generate_series(1, ${count}) AS i`);
  });
  const hitSql = insert(1, 0, `SELECT '${hit}'::uuid, 1, '${matchedBody(arm.query)}'`);
  return [hitSql, ...rows].join('\n');
}

export function slotsSql(arm: ArmFixture, design: Design) {
  const {o, c} = slotScope(arm);
  const match = matchedBody(arm.query);
  // Preserve the SQL text of the unreachable candidate branch for zero-candidate arms.
  const candidate = arm.candidates > 0 ? candidateBody : (arm.matches > 0 ? match : decoy);
  const body = `CASE WHEN i <= ${arm.matches} THEN '${match}'
    WHEN i <= ${arm.candidates} THEN '${candidate}' ELSE '${decoy}' END`;
  const slots = insert(o, c, `SELECT ${nextId(3_000_000)}, i + ${design.messages}, ${body}
    FROM generate_series(1, ${arm.slots}) AS i`);
  return slots + insert(2, 0, `SELECT ${nextId(4_000_000)}, i + ${design.messages + arm.slots}, '${decoy}'
    FROM generate_series(1, ${arm.extraForeignMessages ?? 0}) AS i`);
}

export function finishSequencesSql() {
  return `UPDATE channel_message_sequences s SET seq=m.seq
    FROM (SELECT organization_id,channel_id,max(seq) seq FROM messages GROUP BY 1,2) m
    WHERE s.organization_id=m.organization_id AND s.channel_id=m.channel_id;`;
}

export type DiagnosticAssignments = {
  E: {scope: Scope; query: Query};
  S: {query: Query};
  V: {scope: Scope; query: Query; reference: ArmFixture};
  negative: string;
};

export const reviewedAssignments = {
  E: {scope: 'C1', query: 'Q2'},
  S: {query: 'Q4'},
  V: {scope: 'C2', query: 'Q4', reference: foreignArm('C2', 'Q4', formal.many, formal.many)},
  negative: 'C2-Q4',
} satisfies DiagnosticAssignments;

export function formalPairs(positiveK: number | null, assignments: DiagnosticAssignments | null): Pair[] {
  assert.ok(assignments, 'Formal fixture assignments are unresolved for E, S, V and A/A');
  assert.ok(positiveK !== null && Number.isSafeInteger(positiveK) && positiveK > 0 && positiveK < formal.messages,
    'Freeze P K in the harness PR');
  const judged = judgedPairs(formal);
  const reference = judged.find(pair => pair.id === assignments.negative);
  assert.ok(reference, 'A/A must name its judged few-arm reference');
  return [...judged, existence(assignments.E.scope, assignments.E.query, formal),
    globalSize(assignments.S.query, formal),
    visibilityMap(assignments.V.scope, assignments.V.query, formal, assignments.V.reference),
    positiveControl(positiveK), negativeControl(reference.few)];
}
