-- MEASUREMENT ONLY. Applied as owner to a fresh, disposable migrated database.
-- Derive replacements from installed definitions so later DM/visibility changes
-- and #142/#135 locks survive. Refuse drift rather than silently removing more SQL.
DO $$
DECLARE signature text; definition text; replaced text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['initialize_unread(uuid,uuid,uuid,bigint)','unread_channel_access()'] LOOP
    SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
    IF (SELECT count(*) FROM regexp_matches(definition, 'INSERT INTO topic_read_positions', 'g')) <> 1 THEN
      RAISE EXCEPTION 'unexpected eager insert count in %', signature;
    END IF;
    replaced := regexp_replace(definition, 'INSERT INTO topic_read_positions[^;]+;', '-- measurement-only: inherit Channel initial_seq until explicitly read.');
    IF replaced = definition OR position('INSERT INTO channel_read_positions' in replaced)=0
       OR position('135' in replaced)=0 THEN RAISE EXCEPTION 'unsafe overlay drift: %',signature; END IF;
    EXECUTE replaced;
  END LOOP;
END $$;
