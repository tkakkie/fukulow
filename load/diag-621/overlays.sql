-- #621 C1/C2 diagnosis only. Each block is applied as the owner to one disposable
-- clone of the shared seed. Nothing here is a schema proposal: C1 arms remove a
-- constraint only to attribute its cost; C2 inlines the digest encoder text.
-- Each block refuses any shape it does not expect.

-- @arm fkc
DO $$ DECLARE n text; BEGIN
  SELECT conname INTO STRICT n FROM pg_constraint
   WHERE conrelid = 'public.channel_log'::regclass AND contype = 'f' AND confrelid = 'public.channels'::regclass;
  EXECUTE format('ALTER TABLE public.channel_log DROP CONSTRAINT %I', n);
END $$;

-- @arm fks
DO $$ DECLARE n text; BEGIN
  SELECT conname INTO STRICT n FROM pg_constraint
   WHERE conrelid = 'public.channel_log'::regclass AND contype = 'f' AND confrelid = 'public.users'::regclass;
  EXECUTE format('ALTER TABLE public.channel_log DROP CONSTRAINT %I', n);
END $$;

-- @arm fk2
DO $$ DECLARE n text; BEGIN
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.channel_log'::regclass AND contype = 'f') <> 2 THEN
    RAISE EXCEPTION 'expected exactly two channel_log foreign keys';
  END IF;
  FOR n IN SELECT conname FROM pg_constraint WHERE conrelid = 'public.channel_log'::regclass AND contype = 'f' LOOP
    EXECUTE format('ALTER TABLE public.channel_log DROP CONSTRAINT %I', n);
  END LOOP;
END $$;

-- @arm pk
DO $$ DECLARE n text; BEGIN
  IF (SELECT count(*) FROM pg_index WHERE indrelid = 'public.channel_log'::regclass) <> 1 THEN
    RAISE EXCEPTION 'expected the primary key to be the only channel_log index';
  END IF;
  SELECT conname INTO STRICT n FROM pg_constraint WHERE conrelid = 'public.channel_log'::regclass AND contype = 'p';
  EXECUTE format('ALTER TABLE public.channel_log DROP CONSTRAINT %I', n);
END $$;

-- @arm inline
DO $$
DECLARE encoder text; expr text; trigger_src text; replaced text; probe_expr text; total bigint; mismatches bigint;
BEGIN
  PERFORM set_config('check_function_bodies', 'on', true);
  SELECT prosrc INTO STRICT encoder FROM pg_proc
   WHERE oid = 'public.fukulow_send_digest(uuid,text,text,uuid)'::regprocedure;
  expr := btrim(regexp_replace(encoder, '^\s*SELECT\s+', ''), E' \n\t');
  IF left(expr, 18) <> 'pg_catalog.sha256(' OR position(';' in expr) > 0 OR expr ~* '\m(select|from)\M'
     OR position('NEW.' in expr) > 0 THEN
    RAISE EXCEPTION 'unexpected digest encoder shape';
  END IF;
  -- Same encoder text with the parameters bound to the row being inserted.
  -- topic_key stays: the trigger's local variable has the parameter's name.
  expr := regexp_replace(expr, '\mchannel_id\M', 'NEW.channel_id', 'g');
  expr := regexp_replace(expr, '\mbody\M', 'NEW.body', 'g');
  expr := regexp_replace(expr, '\mreply_to\M', 'NEW.reply_to_id', 'g');
  SELECT prosrc INTO STRICT trigger_src FROM pg_proc WHERE oid = 'public.fukulow_message_created()'::regprocedure;
  IF (SELECT count(*) FROM regexp_matches(trigger_src,
        'public\.fukulow_send_digest\(\s*NEW\.channel_id,\s*NEW\.body,\s*topic_key,\s*NEW\.reply_to_id\)', 'g')) <> 1 THEN
    RAISE EXCEPTION 'unexpected trigger digest call';
  END IF;
  replaced := regexp_replace(trigger_src,
    'public\.fukulow_send_digest\(\s*NEW\.channel_id,\s*NEW\.body,\s*topic_key,\s*NEW\.reply_to_id\)', expr);
  EXECUTE format('CREATE OR REPLACE FUNCTION public.fukulow_message_created() RETURNS trigger LANGUAGE plpgsql AS %L', replaced);
  IF position('fukulow_send_digest' in (SELECT prosrc FROM pg_proc WHERE oid = 'public.fukulow_message_created()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'inline digest not installed';
  END IF;
  -- Byte compatibility: the identical substituted text (NEW. -> m.) against the
  -- stored encoder over Topic, Reply, empty, multibyte and long inputs.
  probe_expr := replace(expr, 'NEW.', 'm.');
  EXECUTE format('CREATE FUNCTION pg_temp.c2_probe(m public.messages, topic_key text) RETURNS bytea LANGUAGE plpgsql AS %L',
    'BEGIN RETURN ' || probe_expr || '; END');
  WITH bodies(b) AS (VALUES (''), ('Load test message'), ('日本語の本文'), ('emoji 🦉 ok'), (repeat('x', 4000)), (E'line\nbreak'), ('a''quote')),
       keys(k) AS (VALUES (NULL), (''), ('topic'), ('トピック'), (repeat('t', 200))),
       replies(r) AS (VALUES (NULL::uuid), (gen_random_uuid())),
       chans(c) AS (SELECT gen_random_uuid() FROM generate_series(1, 20)),
       cases AS (SELECT c, b, k, r, pg_temp.c2_probe(jsonb_populate_record(NULL::public.messages,
                   jsonb_build_object('channel_id', c, 'body', b, 'reply_to_id', r)), k) AS probe
                 FROM chans, bodies, keys, replies)
  SELECT count(*), count(*) FILTER (WHERE probe IS DISTINCT FROM public.fukulow_send_digest(c, b, k, r))
    INTO total, mismatches FROM cases;
  IF total <> 1400 OR mismatches <> 0 THEN
    RAISE EXCEPTION 'digest compatibility failed: % of %', mismatches, total;
  END IF;
  RAISE NOTICE 'C2_COMPAT % 0', total;
END $$;
