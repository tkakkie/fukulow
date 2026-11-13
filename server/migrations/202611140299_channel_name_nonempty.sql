-- Validate every existing row before replacing the old constraint. Operators
-- correct empty names and re-run; never rename, truncate or delete automatically.
ALTER TABLE channels ADD CONSTRAINT channels_name_length_nonempty
    CHECK (char_length(name) BETWEEN 1 AND 128);
ALTER TABLE channels DROP CONSTRAINT channels_name_length;
ALTER TABLE channels RENAME CONSTRAINT channels_name_length_nonempty TO channels_name_length;
