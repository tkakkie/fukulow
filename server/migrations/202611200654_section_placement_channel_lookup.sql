-- Apply the kind check after the composite primary-key lookup. Putting kind
-- in the WHERE clause permits an Organization-wide scan of the partial name
-- index for each placement when Channel statistics are stale.
CREATE OR REPLACE FUNCTION reject_dm_section_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT kind FROM public.channels
        WHERE organization_id = NEW.organization_id AND id = NEW.channel_id)
        IS DISTINCT FROM 'channel' THEN
        RAISE EXCEPTION 'only ordinary Channels can be placed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
