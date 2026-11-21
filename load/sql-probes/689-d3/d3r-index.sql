CREATE TABLE public.search_terms_recent (
    organization_id uuid NOT NULL,
    message_id bigint NOT NULL,
    channel_id uuid NOT NULL,
    term text COLLATE "C" NOT NULL,
    created_at timestamptz NOT NULL,
    FOREIGN KEY (organization_id, message_id) REFERENCES public.messages
);
ALTER TABLE public.search_terms_recent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.search_terms_recent FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.search_terms_recent USING
    (organization_id = public.fukulow_current_org()) WITH CHECK
    (organization_id = public.fukulow_current_org());

CREATE FUNCTION public.recent_search_terms(body text) RETURNS SETOF text
LANGUAGE sql IMMUTABLE STRICT
BEGIN ATOMIC
    SELECT DISTINCT substr(body, pos, width) COLLATE "C"
       FROM generate_series(1, 3) AS widths(width)
       CROSS JOIN LATERAL generate_series(1, length(body) - width + 1) AS positions(pos);
END;

INSERT INTO public.search_terms_recent (organization_id, message_id, channel_id, term, created_at)
SELECT m.organization_id, m.id, m.channel_id, gram.term, m.created_at
FROM public.messages m CROSS JOIN LATERAL public.recent_search_terms(m.normalized_body) AS gram(term);
CREATE UNIQUE INDEX search_terms_recent_key
    ON public.search_terms_recent (organization_id, channel_id, term, created_at DESC, message_id DESC);
CREATE INDEX search_terms_recent_message ON public.search_terms_recent (organization_id, message_id);

CREATE FUNCTION public.maintain_search_terms_recent() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        DELETE FROM public.search_terms_recent
        WHERE organization_id = OLD.organization_id AND message_id = OLD.id;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    END IF;
    INSERT INTO public.search_terms_recent (organization_id, message_id, channel_id, term, created_at)
    SELECT NEW.organization_id, NEW.id, NEW.channel_id, gram.term, NEW.created_at
    FROM public.recent_search_terms(NEW.normalized_body) AS gram(term);
    RETURN NULL;
END $$;

CREATE TRIGGER search_terms_recent_remove BEFORE DELETE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.maintain_search_terms_recent();
CREATE TRIGGER search_terms_recent_store AFTER INSERT OR UPDATE OF body, channel_id, created_at ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.maintain_search_terms_recent();

GRANT SELECT ON public.search_terms_recent TO fukulow_probe;
GRANT SELECT, INSERT, DELETE ON public.search_terms_recent TO fukulow_probe_writer;
