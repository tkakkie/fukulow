-- Restore/cutover epochs are explicit operator state, never startup state.
ALTER TABLE organizations ADD COLUMN history_generation uuid NOT NULL DEFAULT gen_random_uuid();

-- Messages owns this counter. Creates do not change the projection mutation floor.
ALTER TABLE channel_message_sequences ADD COLUMN mutation_seq bigint NOT NULL DEFAULT 0
    CHECK (mutation_seq >= 0 AND mutation_seq <= seq);
