-- MEASUREMENT ONLY. Applied as owner to a fresh, disposable migrated database.
-- Derive replacements from installed definitions so later DM/visibility changes
-- and #142/#135 locks survive. Each eager Topic insert is either a standalone
-- statement or the outer statement over `WITH inserted AS (INSERT INTO
-- channel_read_positions ... RETURNING ...)`; the latter keeps only the inner
-- Channel insert. Refuse any other shape rather than silently removing more SQL.
DO $$
DECLARE signature text; definition text; replaced text; locks text[];
BEGIN
  -- Bodies are validated on CREATE, so a broken overlay fails here, not later.
  PERFORM set_config('check_function_bodies', 'on', true);
  FOREACH signature IN ARRAY ARRAY['initialize_unread(uuid,uuid,uuid,bigint)','unread_channel_access()'] LOOP
    SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
    IF (SELECT count(*) FROM regexp_matches(definition, 'INSERT INTO topic_read_positions', 'g')) <> 1
       OR (SELECT count(*) FROM regexp_matches(definition, 'INSERT INTO channel_read_positions', 'g')) <> 1 THEN
      RAISE EXCEPTION 'unexpected insert count in %', signature;
    END IF;
    IF position('WITH inserted AS' in definition) > 0 THEN
      replaced := regexp_replace(definition, 'WITH inserted AS \(\s*INSERT INTO channel_read_positions', 'INSERT INTO channel_read_positions');
      replaced := regexp_replace(replaced, '\s*RETURNING [^()]+\)\s*INSERT INTO topic_read_positions[^;]+;',
        '; -- measurement-only: inherit Channel initial_seq until explicitly read.');
    ELSE
      replaced := regexp_replace(definition, 'INSERT INTO topic_read_positions[^;]+;', '-- measurement-only: inherit Channel initial_seq until explicitly read.');
    END IF;
    locks := CASE WHEN signature LIKE 'unread_channel_access%' THEN ARRAY['142','135'] ELSE ARRAY['135'] END;
    IF replaced = definition OR position('topic_read_positions' in replaced) > 0
       OR position('WITH inserted' in replaced) > 0 OR position('RETURNING' in replaced) > 0
       OR position('INSERT INTO channel_read_positions' in replaced) = 0
       OR EXISTS (SELECT 1 FROM unnest(locks) l WHERE position(l in replaced) = 0) THEN
      RAISE EXCEPTION 'unsafe overlay drift: %', signature;
    END IF;
    EXECUTE replaced;
    IF position('topic_read_positions' in pg_get_functiondef(signature::regprocedure)) > 0 THEN
      RAISE EXCEPTION 'overlay not installed: %', signature;
    END IF;
  END LOOP;
END $$;
