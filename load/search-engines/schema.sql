CREATE EXTENSION pg_trgm;
CREATE EXTENSION pg_bigm;
CREATE COLLATION search_unicode (provider = builtin, locale = 'PG_UNICODE_FAST');
CREATE FUNCTION search_normalize(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT
RETURN normalize(casefold(normalize($1, NFC) COLLATE public.search_unicode), NFC) COLLATE "C";
ALTER TABLE messages ADD COLUMN normalized_body text COLLATE "C"
    GENERATED ALWAYS AS (search_normalize(body)) STORED;
-- Identical visibility/range/page support for every variant, including the control.
CREATE INDEX search_channel_recent ON messages (organization_id, channel_id, created_at DESC, id DESC);
