CREATE FUNCTION public.fukulow_search_normalize(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN CASE WHEN octet_length(value) = char_length(value) THEN lower(value COLLATE pg_catalog."C")
    ELSE (
        -- Unicode 16.0 Default_Ignorable_Code_Point. Map each scalar before NFC so
        -- combining marks cannot reorder across a scalar that folds to a starter.
        SELECT normalize(coalesce(string_agg(
            normalize(casefold(normalize(scalar, NFKC) COLLATE pg_catalog.pg_unicode_fast), NFKC),
            '' ORDER BY position
        ), ''), NFC)
        FROM string_to_table(regexp_replace(value COLLATE pg_catalog."C",
            U&'[\00AD\034F\061C\115F-\1160\17B4-\17B5\180B-\180F\200B-\200F\202A-\202E\2060-\206F\3164\FE00-\FE0F\FEFF\FFA0\FFF0-\FFF8\+01BCA0-\+01BCA3\+01D173-\+01D17A\+0E0000-\+0E0FFF]',
            '', 'g'), NULL) WITH ORDINALITY AS scalars(scalar, position)
    ) END;

CREATE FUNCTION public.fukulow_search_terms(body text) RETURNS SETOF text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    BEGIN ATOMIC
        WITH normalized AS MATERIALIZED (SELECT public.fukulow_search_normalize(body) AS value)
        SELECT DISTINCT substr(value, position, width) COLLATE pg_catalog."C"
        FROM normalized
        CROSS JOIN (VALUES (2), (3)) AS widths(width)
        CROSS JOIN LATERAL generate_series(1, char_length(value) - width + 1) AS positions(position);
    END;

CREATE TABLE public.message_search_terms (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    term text COLLATE pg_catalog."C" NOT NULL CHECK (char_length(term) IN (2, 3)),
    created_at timestamptz NOT NULL,
    message_id uuid NOT NULL,
    FOREIGN KEY (organization_id, message_id) REFERENCES public.messages(organization_id, id) ON DELETE CASCADE
);

-- Keep table-wide term frequencies out of query planning.
ALTER TABLE public.message_search_terms ALTER COLUMN term SET STATISTICS 0;

CREATE UNIQUE INDEX message_search_terms_lookup
    ON public.message_search_terms (organization_id, channel_id, term, created_at DESC, message_id DESC);
CREATE INDEX message_search_terms_maintenance
    ON public.message_search_terms (organization_id, message_id);

ALTER TABLE public.message_search_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_search_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.message_search_terms FOR ALL
    USING (organization_id = public.fukulow_current_org())
    WITH CHECK (organization_id = public.fukulow_current_org());

-- Deployment stops old writers before migration. Keep the backfill stable until COMMIT.
LOCK TABLE public.messages IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    org uuid;
BEGIN
    FOR org IN SELECT organization_id FROM public.organizations LOOP
        PERFORM set_config('fukulow.organization_id', org::text, true);
        INSERT INTO public.message_search_terms (organization_id, channel_id, term, created_at, message_id)
        SELECT m.organization_id, m.channel_id, term, m.created_at, m.id
        FROM public.messages AS m
        CROSS JOIN LATERAL public.fukulow_search_terms(m.body) AS terms(term)
        WHERE m.organization_id = org AND NOT m.deleted;
    END LOOP;
END;
$$;
