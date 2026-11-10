CREATE TABLE topics (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    name_key text COLLATE "C" GENERATED ALWAYS AS (lower(name COLLATE "C")) STORED,
    first_seq bigint NOT NULL CHECK (first_seq >= 1),
    last_seq bigint NOT NULL CHECK (last_seq >= first_seq),
    message_count bigint NOT NULL CHECK (message_count >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, channel_id, id),
    UNIQUE (organization_id, channel_id, name_key),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id)
);

ALTER TABLE messages ADD COLUMN topic_id uuid NULL;
ALTER TABLE messages ADD CONSTRAINT messages_topic_channel_fk
    FOREIGN KEY (organization_id, channel_id, topic_id)
    REFERENCES topics (organization_id, channel_id, id);

-- Covers immutable W-relative counts and positions, as well as Topic history.
CREATE INDEX messages_topic_seq ON messages (organization_id, channel_id, topic_id, seq);
