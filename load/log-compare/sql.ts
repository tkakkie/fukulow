import { readFileSync } from 'node:fs';
import { arms, organization, sender, snapshot, logTable, type Arm } from './model.ts';
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
export function variantSchema(arm: Arm): string {
  if (!arms.includes(arm)) throw new Error('unknown arm');
  return read(arm === 'baseline' ? 'baseline.sql' : arm.startsWith('events') ? 'channel_events.sql' : 'channel_log.sql')
    .replace('/* SNAPSHOTS */', snapshot(arm) ? `CREATE TABLE creation_snapshots (
      organization_id uuid NOT NULL, channel_id uuid NOT NULL, position bigint NOT NULL,
      message_id uuid NOT NULL, version bigint NOT NULL, payload jsonb NOT NULL,
      PRIMARY KEY (organization_id, channel_id, position),
      FOREIGN KEY (organization_id, channel_id, message_id) REFERENCES messages (organization_id, channel_id, id));` : '');
}
export const commonSchema = () => read('common.sql');
export const org = `'${organization}'::uuid`;
export const member = `'${sender}'::uuid`;
const payload = (alias: string) => `jsonb_build_object('id',${alias}.id,'body',${alias}.body,'deleted',${alias}.deleted,
  'topic_id',${alias}.topic_id,'reply_to_id',${alias}.reply_to_id,'reply_root_id',${alias}.reply_root_id,
  'sender',${alias}.sender,'client_message_id',${alias}.client_message_id,'seq',${alias}.seq,
  'created_at',${alias}.created_at,'version',${alias}.version)`;
export function record(arm: Arm, kind: string, row: string, position: string) {
  if (arm === 'baseline') return '';
  const columns = `organization_id,channel_id,position,message_id,version,${logTable(arm) === 'channel_log' || kind !== "'Create'" ? 'kind,' : ''}payload`;
  if (arm.startsWith('events') && kind === "'Create'") return snapshot(arm) ?
    `INSERT INTO creation_snapshots (organization_id,channel_id,position,message_id,version,payload)
     VALUES (${org},ch,${position},${row}.id,${row}.version,${payload(row)});` : '';
  return `INSERT INTO ${logTable(arm)} (${columns}) VALUES
    (${org},ch,${position},${row}.id,${row}.version,${kind},${snapshot(arm) ? payload(row) : 'NULL'});`;
}
export function functions(arm: Arm, perChannel = 100000) {
  return `CREATE FUNCTION apply_op(c integer, n bigint, op integer, b text, fresh boolean, reply boolean)
  RETURNS bigint LANGUAGE plpgsql AS $$
  DECLARE ch uuid := fixture_id(c,0); mid uuid := fixture_id(c,1000000000+n);
    client uuid := fixture_id(c,2000000000+n); t uuid; target uuid; p bigint;
    r messages%ROWTYPE; receipt send_receipts%ROWTYPE; old_topics uuid[];
  BEGIN
    -- Corresponds to the original-send lookup before the #135 barrier.
    IF op=0 THEN
      SELECT * INTO receipt FROM send_receipts WHERE organization_id=${org} AND sender=${member} AND client_message_id=client;
      IF FOUND THEN
        IF receipt.request_hash <> send_hash(b,ch,CASE WHEN fresh THEN mid ELSE NULL END,CASE WHEN reply THEN fixture_id(c,40) ELSE NULL END)
          THEN RAISE EXCEPTION 'idempotency conflict'; END IF;
        RETURN receipt.original_seq;
      END IF;
      IF reply THEN PERFORM 1 FROM messages WHERE organization_id=${org} AND channel_id=ch AND id=fixture_id(c,40);
        IF NOT FOUND THEN RAISE EXCEPTION 'missing reply parent'; END IF; END IF;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(${org}::text || '/' || ch::text,135));
    IF op=0 THEN
      -- Catch a concurrent retry after obtaining the Channel barrier, before allocation.
      SELECT * INTO receipt FROM send_receipts WHERE organization_id=${org} AND sender=${member} AND client_message_id=client;
      IF FOUND THEN
        IF receipt.request_hash <> send_hash(b,ch,CASE WHEN fresh THEN mid ELSE NULL END,CASE WHEN reply THEN fixture_id(c,40) ELSE NULL END)
          THEN RAISE EXCEPTION 'idempotency conflict'; END IF;
        RETURN receipt.original_seq;
      END IF;
      INSERT INTO channel_message_sequences VALUES (${org},ch,1) ON CONFLICT (organization_id,channel_id)
        DO UPDATE SET seq=channel_message_sequences.seq+1 RETURNING seq INTO p;
      IF reply THEN SELECT topic_id INTO t FROM messages WHERE organization_id=${org} AND channel_id=ch AND id=fixture_id(c,40);
      ELSE
        t := CASE WHEN fresh THEN mid ELSE fixture_id(c,-1) END;
        INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count)
          VALUES (${org},ch,t,CASE WHEN fresh THEN mid::text ELSE 'topic 1' END,p,p,1)
          ON CONFLICT (organization_id,channel_id,name_key) DO NOTHING;
      END IF;
      INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id,reply_to_id,reply_root_id)
        VALUES (${org},mid,ch,p,${member},client,b,t,CASE WHEN reply THEN fixture_id(c,40) ELSE NULL END,
          CASE WHEN reply THEN fixture_id(c,40) ELSE NULL END) RETURNING * INTO r;
      ${record(arm, "'Create'", 'r', 'p')}
      INSERT INTO send_receipts VALUES (${org},${member},client,mid,p,
        send_hash(b,ch,CASE WHEN fresh THEN mid ELSE NULL END,CASE WHEN reply THEN fixture_id(c,40) ELSE NULL END));
      UPDATE topics SET last_seq=p,message_count=message_count+1 WHERE organization_id=${org} AND id=t AND last_seq<>p;
      RETURN p;
    END IF;
    -- Edit repeatedly hits one Message; Move includes the root and seven Replies.
    target := CASE WHEN op=1 THEN fixture_id(c,20) WHEN op=2 THEN fixture_id(c,1) ELSE fixture_id(c,100+((n%1000000)*16+n/1000000)%${perChannel-100}) END;
    IF op=2 THEN
      SELECT array_agg(DISTINCT topic_id) INTO old_topics FROM messages WHERE organization_id=${org} AND channel_id=ch
        AND (id=target OR reply_root_id=target);
      SELECT CASE WHEN topic_id=fixture_id(c,-1) THEN fixture_id(c,-2) ELSE fixture_id(c,-1) END INTO t
        FROM messages WHERE organization_id=${org} AND channel_id=ch AND id=target;
      -- A Move may also create a Topic. Both fixture destination Topics are nonempty.
    END IF;
    FOR r IN SELECT * FROM messages WHERE organization_id=${org} AND channel_id=ch
      AND (id=target OR (op=2 AND reply_root_id=target)) ORDER BY seq
    LOOP
      ${arm === 'baseline' ? 'p := r.seq;' : `UPDATE channel_message_sequences SET seq=seq+1 WHERE organization_id=${org} AND channel_id=ch RETURNING seq INTO p;`}
      UPDATE messages SET version=version+1,
        body=CASE WHEN op=3 THEN '' WHEN op=1 AND NOT deleted THEN b ELSE body END,
        deleted=deleted OR op=3, topic_id=CASE WHEN op=2 THEN t ELSE topic_id END
        WHERE organization_id=${org} AND id=r.id RETURNING * INTO r;
      ${record(arm, "CASE op WHEN 1 THEN 'Edit' WHEN 2 THEN 'Move' ELSE 'Delete' END", 'r', 'p')}
    END LOOP;
    IF NOT FOUND THEN RAISE EXCEPTION 'missing mutation target'; END IF;
    -- Proposed mutation cache maintenance, identical in all arms; production has
    -- no Edit/Move/Delete implementation yet. Count tombstones as positions.
    IF op=2 THEN
      UPDATE topics tt SET first_seq=s.first_seq,last_seq=s.last_seq,message_count=s.n
      FROM (SELECT topic_id,min(seq) first_seq,max(seq) last_seq,count(*) n FROM messages
        WHERE organization_id=${org} AND channel_id=ch AND (topic_id=ANY(old_topics) OR topic_id=t)
        GROUP BY topic_id) s WHERE tt.organization_id=${org} AND tt.channel_id=ch AND tt.id=s.topic_id;
    END IF;
    RETURN p;
  END $$;`;
}
export function seedSQL(arm: Arm, channels: number, perChannel: number, bodySize = 17) {
  return `INSERT INTO users VALUES (${org},${member});
  INSERT INTO channels (organization_id,id) SELECT ${org},fixture_id(c,0) FROM generate_series(1,${channels}) c;
  INSERT INTO channel_message_sequences SELECT ${org},fixture_id(c,0),${perChannel} FROM generate_series(1,${channels}) c;
  INSERT INTO topics (organization_id,channel_id,id,name,first_seq,last_seq,message_count)
    SELECT ${org},fixture_id(c,0),fixture_id(c,-t),'topic '||t,t,${perChannel}-(((${perChannel}%2)+t)%2),
      ${Math.floor(perChannel/2)} FROM generate_series(1,${channels}) c CROSS JOIN generate_series(1,2) t;
  INSERT INTO messages (organization_id,id,channel_id,seq,sender,client_message_id,body,topic_id,reply_to_id,reply_root_id)
    SELECT ${org},fixture_id(c,n),fixture_id(c,0),n,${member},fixture_id(c,n),fixture_body(n,${bodySize}),
      fixture_id(c,CASE WHEN n<=8 THEN -1 ELSE -(1+n%2) END),
      CASE WHEN n BETWEEN 2 AND 8 THEN fixture_id(c,1) END,CASE WHEN n BETWEEN 2 AND 8 THEN fixture_id(c,1) END
      FROM generate_series(1,${channels}) c CROSS JOIN generate_series(1,${perChannel}) n;
  UPDATE topics t SET first_seq=s.lo,last_seq=s.hi,message_count=s.n FROM
    (SELECT organization_id,topic_id,min(seq) lo,max(seq) hi,count(*) n FROM messages GROUP BY organization_id,topic_id) s
    WHERE t.organization_id=s.organization_id AND t.id=s.topic_id;
  INSERT INTO send_receipts SELECT organization_id,sender,client_message_id,id,seq,
    send_hash(body,channel_id,topic_id,reply_to_id) FROM messages;
  ${backfill(arm)} ANALYZE;`;
}
export function backfill(arm: Arm) {
  if (arm === 'baseline') return '';
  const table = arm.startsWith('events') ? 'creation_snapshots' : 'channel_log';
  if (arm === 'events-ids') return '';
  return `INSERT INTO ${table} (organization_id,channel_id,position,message_id,version,${table === 'channel_log' ? 'kind,' : ''}payload)
    SELECT organization_id,channel_id,seq,id,version,${table === 'channel_log' ? "'Create'," : ''}
      ${snapshot(arm) ? payload('m') : 'NULL'} FROM messages m;`;
}
export function replaySQL(arm: Arm, after: number, limit = 50, channel = 1) {
  const scope = `organization_id=${org} AND channel_id=fixture_id(${channel},0)`;
  const creation = `SELECT seq AS position,id AS message_id,1::bigint AS version,'Create'::text AS kind,NULL::jsonb AS payload
      FROM messages WHERE ${scope} AND seq>${after} ORDER BY seq LIMIT ${limit}`;
  let positions: string;
  if (arm === 'baseline') positions = creation;
  else if (arm.startsWith('events')) positions = `SELECT * FROM ((${snapshot(arm) ?
    `SELECT position,message_id,version,'Create'::text AS kind,payload FROM creation_snapshots WHERE ${scope} AND position>${after} ORDER BY position LIMIT ${limit}` : creation})
    UNION ALL (SELECT position,message_id,version,kind,payload FROM channel_events WHERE ${scope} AND position>${after} ORDER BY position LIMIT ${limit})) u ORDER BY position LIMIT ${limit}`;
  else positions = `SELECT position,message_id,version,kind,payload FROM channel_log WHERE ${scope} AND position>${after} ORDER BY position LIMIT ${limit}`;
  // ids reconciles each entry against current state; snapshots replay immutable
  // records and only become deleted when the Delete position is reduced.
  return `WITH page AS MATERIALIZED (${positions}) SELECT p.position,p.message_id AS id,
    ${snapshot(arm) ? "p.version,COALESCE((p.payload->>'deleted')::boolean,false) AS deleted,p.payload->>'body' AS body,p.payload" : 'm.version,m.deleted,m.body,to_jsonb(m) AS payload'}
    FROM page p ${snapshot(arm) ? '' : `JOIN messages m ON m.organization_id=${org} AND m.channel_id=fixture_id(${channel},0) AND m.id=p.message_id`}
    ORDER BY p.position`;
}
export function workloadSQL(body: string, channels: number, mix: [number,number,number,number]) {
  return `\\set n :n + 1
\\set c 1 + (:client_id + :n - 1) % ${channels}
\\set ticket (:n - 1 + :client_id * 37) % 100
\\set op CASE WHEN :ticket < ${mix[0]} THEN 0 WHEN :ticket < ${mix[0]+mix[1]} THEN 1 WHEN :ticket < ${100-mix[3]} THEN 2 ELSE 3 END
BEGIN;
SELECT set_config('fukulow.organization_id','${organization}',true);
SELECT apply_op(:c, :client_id * 1000000 + :n, :op,
  CASE WHEN :op=1 THEN chr(${body.length===17 ? '65+(:n%26)' : '131072+(:n%65536)'}::integer)||substr('${body}',2) ELSE '${body}' END, (:n % 10)=1, (:n % 5)=0);
COMMIT;
`;
}
