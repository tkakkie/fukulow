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
            E'[\u00AD\u034F\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF]',
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
    FOREIGN KEY (organization_id, channel_id, message_id)
        REFERENCES public.messages(organization_id, channel_id, id) ON DELETE CASCADE
);

-- Keep table-wide term frequencies out of query planning.
ALTER TABLE public.message_search_terms ALTER COLUMN term SET STATISTICS 0;

CREATE UNIQUE INDEX message_search_terms_lookup
    ON public.message_search_terms (organization_id, channel_id, term, created_at DESC, message_id DESC);
CREATE INDEX message_search_terms_maintenance
    ON public.message_search_terms (organization_id, message_id);

-- The migration owner backfills across Organizations. Fail if RLS would filter rows.
SET LOCAL row_security = off;
-- Deployment stops old writers before migration. Keep the backfill stable until COMMIT.
LOCK TABLE public.messages IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO public.message_search_terms (organization_id, channel_id, term, created_at, message_id)
SELECT m.organization_id, m.channel_id, term, m.created_at, m.id
FROM public.messages AS m
CROSS JOIN LATERAL public.fukulow_search_terms(m.body) AS terms(term)
WHERE NOT m.deleted;

ALTER TABLE public.message_search_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_search_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.message_search_terms FOR ALL
    USING (organization_id = public.fukulow_current_org())
    WITH CHECK (organization_id = public.fukulow_current_org());
