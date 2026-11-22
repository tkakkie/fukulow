CREATE OR REPLACE FUNCTION public.fukulow_search_terms(body text) RETURNS SETOF text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    BEGIN ATOMIC
        SELECT NULL::text WHERE false;
    END;
