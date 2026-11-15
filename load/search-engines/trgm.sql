CREATE INDEX search_body ON messages USING gin (normalized_body gin_trgm_ops);
