-- Validate existing names too; operators must resolve violations and re-run.
-- Never truncate, rename or delete existing Channels automatically.
ALTER TABLE channels ADD CONSTRAINT channels_name_length
    CHECK (char_length(name) <= 128);
